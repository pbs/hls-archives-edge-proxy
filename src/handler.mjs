// The Lambda@Edge origin-request handler. Every *.arch.* response is generated here and the origin is
// never asked for one; any other request passes through untouched.

import { defaults } from './config.mjs';
import { parseMediaPlaylist, serializeMediaPlaylist, serializeArchive, rewriteMultivariant, isMultivariant } from './playlist.mjs';
import {
  parseRoute, sized, isBucket, bucketOf, newestPublished, liveStartMsn,
  tableName, rangeForTable, buildTable, archiveTags, formatArchiveTag, archivedDateranges,
} from './archives.mjs';
import { fetchText, fetchJson, fetchRange, UpstreamError } from './upstream.mjs';
import { withOrigin, originUrls } from './origins.mjs';

const ARCHIVE_TYPE = 'application/vnd.apple.mpegurl';

// `overrides` is for the tests, the check script and the demos: a fetch to use, and settings.
export function createHandler(overrides = {}) {
  return async function handler(event) {
    const { request, config: cf } = event.Records[0].cf;
    const route = parseRoute(request.uri);
    if (!route) return request.uri.includes('.arch.') ? respond(404, 'not found\n', 'text/plain', 'max-age=60') : request;

    const cfg = withOrigin(request.uri, { ...defaults, ...overrides });
    const base = `https://${cfg.upstreamHost ?? cf.distributionDomainName}${route.dir}`;
    const ctx = { ...route, cfg, base, upstream: `${base}${route.name}.m3u8` };
    try {
      if (route.kind === 'playlist') return await playlist(ctx);
      if (route.kind === 'table') return await table(ctx);
      return await archive(ctx);
    } catch (err) {
      log('error', { uri: request.uri, status: err.status, message: err.message });
      const status = err instanceof UpstreamError && err.status < 500 ? 404 : 502;
      return respond(status, `${status}\n`, 'text/plain', 'max-age=1');
    }
  };
}

export const handler = createHandler();

async function playlist({ cfg, upstream, base, name, infix, windowSeconds }) {
  // A multivariant comes back as it is; a media playlist comes back as its last 15 minutes or so.
  const res = await fetchText(originUrls(cfg).tail(upstream, cfg, nowSec()), cfg);
  if (isMultivariant(res.body)) return respond(200, rewriteMultivariant(res.body, infix), res.contentType, res.cacheControl);

  const pl = parseMediaPlaylist(res.body);
  if (!pl.segments.length) throw new Error('empty live playlist');
  if (windowSeconds) cfg = { ...cfg, presentationSeconds: Math.min(windowSeconds, cfg.maxPresentationSeconds), presentationSegments: undefined };
  cfg = sized(cfg, pl.segments);
  const liveLast = pl.segments.at(-1).msn;
  const start = liveStartMsn(liveLast, cfg);
  if (pl.segments[0].msn > start) log('short-tail', { name, have: pl.segments.length, want: cfg.archiveSegments + cfg.marginSegments });
  const from = Math.max(0, pl.segments.findIndex((s) => s.msn >= start));

  let tags = [], dateranges = [];
  const k = newestPublished(liveLast, cfg);
  if (k >= 0) {
    // Without a table, serve a plain live playlist rather than wrong tags.
    const t = await fetchJson(`${base}${tableName(name, k, cfg)}`, cfg).catch((err) => {
      log('table-unavailable', { name, k, message: err.message });
      return null;
    });
    if (t) {
      const last = pl.segments.at(-1);
      const archives = archiveTags(t, liveLast, name, cfg, { liveEndMs: last.pdtMs + last.dur * 1000, liveFirst: pl.segments[from].msn });
      tags = archives.map(formatArchiveTag);
      if (archives.length) dateranges = archivedDateranges(t, archives[0].first);
    }
  }

  return respond(200, serializeMediaPlaylist(pl, { from, archiveTags: tags, dateranges }), res.contentType, res.cacheControl);
}

async function table({ cfg, upstream, name, a, b }) {
  const n = b - a + 1;
  if (a % n !== 0 || n < 10 || n > 1000 || (cfg.archiveSegments !== 'auto' && n !== cfg.archiveSegments)) {
    return respond(404, 'not a bucket\n', 'text/plain', 'max-age=60');
  }

  // The live playlist anchors MSNs to times; then read back far enough for the whole table.
  const live = parseMediaPlaylist((await fetchText(originUrls(cfg).tail(upstream, cfg, nowSec()), cfg)).body);
  if (!live.segments.length) throw new Error('empty live playlist');
  cfg = sized(cfg, live.segments);
  if (!isBucket(a, b, cfg)) return respond(404, 'not a bucket\n', 'text/plain', 'max-age=60');
  if (b > live.segments.at(-1).msn - cfg.marginSegments) return respond(404, 'bucket not closed yet\n', 'text/plain', 'max-age=2');

  const k = bucketOf(a, cfg);
  const { startSec, endSec } = rangeForTable(live.segments, k, cfg);
  const t = buildTable(await fetchRange(upstream, startSec, endSec, cfg), k, cfg);
  if (t.buckets.at(-1)?.b !== b) {
    // Cache the failure briefly so playlist refreshes don't rebuild it every two seconds.
    log('table-incomplete', { name, k, buckets: t.buckets.length });
    return respond(503, 'table incomplete\n', 'text/plain', 'max-age=30');
  }
  return respond(200, JSON.stringify(t), 'application/json', `public, max-age=${cfg.tableCacheSeconds}`);
}

async function archive({ cfg, upstream, name, a, b, s, e }) {
  // The name says how many segments an archive has.
  if (cfg.archiveSegments === 'auto') cfg = { ...cfg, archiveSegments: b - a + 1 };
  const n = cfg.archiveSegments;
  if (!isBucket(a, b, cfg) || n < 10 || n > 1000 || e <= s || e - s > n * 60) return respond(404, 'not an archive\n', 'text/plain', 'max-age=60');

  const pl = parseMediaPlaylist((await fetchText(originUrls(cfg).range(upstream, s, e), cfg)).body);
  const segs = pl.segments.filter((x) => x.msn >= a && x.msn <= b);
  if (segs.length !== n || segs[0].msn !== a) {
    log('archive-range', { name, a, b, s, e, first: segs[0]?.msn, count: segs.length });
    return respond(404, 'archive not available\n', 'text/plain', 'max-age=2');
  }
  return respond(200, serializeArchive(segs, { hasDsn: pl.hasDsn }), ARCHIVE_TYPE, `public, max-age=${cfg.archiveCacheSeconds}`);
}

const nowSec = () => Math.floor(Date.now() / 1000);

function respond(status, body, contentType, cacheControl) {
  return {
    status: String(status),
    headers: {
      'content-type': [{ key: 'Content-Type', value: contentType }],
      'cache-control': [{ key: 'Cache-Control', value: cacheControl }],
    },
    body,
  };
}

function log(kind, fields) {
  console.log(JSON.stringify({ kind, ...fields }));
}
