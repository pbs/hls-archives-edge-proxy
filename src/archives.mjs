// Archives are fixed runs of N consecutive Media Sequence Numbers, starting at a multiple of N.
// Everything about one follows from its first MSN, so any edge at any time computes the same
// names and the same contents, with no state.

import { iso, median } from './playlist.mjs';

// Segment counts from the time-based settings, using the median duration of `segments`.
export function sized(cfg, segments) {
  const typical = median(segments.map((s) => s.dur));
  const n = cfg.archiveSegments === 'auto' ? Math.max(1, Math.round(cfg.archiveSeconds / typical)) : cfg.archiveSegments;
  return {
    ...cfg,
    archiveSegments: n,
    presentationSegments: cfg.presentationSegments ?? Math.round(cfg.presentationSeconds / typical),
    archiveCount: cfg.archiveCount ?? Math.ceil(cfg.maxPresentationSeconds / (n * typical)) + 1,
  };
}

export const bucketOf = (msn, cfg) => Math.floor(msn / cfg.archiveSegments);
export const bucketRange = (k, cfg) => [k * cfg.archiveSegments, (k + 1) * cfg.archiveSegments - 1];
export const isBucket = (a, b, cfg) => a % cfg.archiveSegments === 0 && b === a + cfg.archiveSegments - 1;

// The newest bucket that ends at least marginSegments behind the live edge.
export const newestPublished = (liveLast, cfg) => Math.floor((liveLast - cfg.marginSegments + 1) / cfg.archiveSegments) - 1;

// The live playlist keeps one archive plus the margin, so it always overlaps the newest archive
// and archived segments roll out of it one at a time.
export const liveStartMsn = (liveLast, cfg) => liveLast - (cfg.archiveSegments + cfg.marginSegments) + 1;

export const presentationStart = (liveLast, cfg) => liveLast - cfg.presentationSegments + 1;

export const liveTailStart = (nowSec, cfg) => Math.floor(nowSec / cfg.liveTailQuantumSeconds) * cfg.liveTailQuantumSeconds - cfg.liveTailSeconds;

// Names. Everything generated sits next to the origin's playlist and has ".arch." in it, so one
// CloudFront behavior (*.arch.*) catches it all and relative segment URIs keep working.
//
//   index.arch.m3u8                           playlist (multivariant or media), default window
//   index.arch.6h.m3u8                        a 6-hour window (30m, 1h30m and 900s work too)
//   index.arch.<a>-<b>.json                   table of the buckets up to a..b
//   index.arch.<a>-<b>.<s>-<e>.m3u8a          archive of MSNs a..b, read as the range s..e
//
// The name can be empty: Unified Origin's multivariant is channel.isml/.m3u8.

const PLAYLIST = /^(.*\/)([^/]*?)\.arch(?:\.([^./]+))?\.m3u8$/;
const TABLE = /^(.*\/)([^/]*?)\.arch\.(\d+)-(\d+)\.json$/;
const ARCHIVE = /^(.*\/)([^/]*?)\.arch\.(\d+)-(\d+)\.(\d+)-(\d+)\.m3u8a$/;

export function parseRoute(uri) {
  let m;
  if ((m = uri.match(PLAYLIST))) {
    const window = parseWindow(m[3]);
    return window ? { kind: 'playlist', dir: m[1], name: m[2], infix: m[3] ?? '', ...window } : null;
  }
  if ((m = uri.match(TABLE))) return { kind: 'table', dir: m[1], name: m[2], a: +m[3], b: +m[4] };
  if ((m = uri.match(ARCHIVE))) return { kind: 'archive', dir: m[1], name: m[2], a: +m[3], b: +m[4], s: +m[5], e: +m[6] };
  return null;
}

// "2h", "30m", "1h30m", "900s" → { windowSeconds }
export function parseWindow(infix) {
  if (!infix) return {};
  const m = infix.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !m[0]) return null;
  return { windowSeconds: (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) };
}

export const tableName = (name, k, cfg) => {
  const [a, b] = bucketRange(k, cfg);
  return `${name}.arch.${a}-${b}.json`;
};

export const archiveName = (name, bk) => `${name}.arch.${bk.a}-${bk.b}.${bk.s}-${bk.e}.m3u8a`;

// Tables. Table k describes the buckets up to bucket k, as far back as maxPresentationSeconds:
//
//   { v, n, k, buckets: [{ a, b, dsn, pdt, s, e, dur: [[seconds, count], ...], dr: [[offset, line], ...] }] }
//
// s and e are the whole seconds that make the origin return a..b, plus at most one segment on each
// side. dur is run-length encoded. dr holds the bucket's EXT-X-DATERANGE lines, which the media
// playlist carries for archived segments. A table depends only on closed segments, so every edge
// builds the same one.

// The time range to read for table k, anchored on the live playlist. The start is on a whole hour
// and the end on the ten-minute mark past bucket k, so the reads are the same for every edge and
// consecutive tables share all but the newest chunk in CloudFront's cache.
export function rangeForTable(liveSegments, k, cfg) {
  const nominal = median(liveSegments.map((s) => s.dur));
  const [oldest] = bucketRange(Math.max(0, k - cfg.archiveCount), cfg);
  const [, lastOfK] = bucketRange(k, cfg);
  const anchor = liveSegments.find((s) => s.msn === lastOfK) ?? liveSegments.at(-1);
  const back = (anchor.msn - oldest) * nominal;
  const grid = Math.min(cfg.maxRangeSeconds || 3600, 3600);
  return {
    startSec: Math.floor((anchor.pdtMs / 1000 - back * 1.02 - 120) / grid) * grid,
    endSec: Math.ceil((anchor.pdtMs / 1000 + anchor.dur) / cfg.liveTailQuantumSeconds) * cfg.liveTailQuantumSeconds,
  };
}

export function buildTable(segments, k, cfg) {
  const byMsn = new Map(segments.map((s) => [s.msn, s]));
  const buckets = [];
  for (let j = k; j >= Math.max(0, k - cfg.archiveCount); j--) {
    const [a, b] = bucketRange(j, cfg);
    const segs = [];
    for (let m = a; m <= b && byMsn.has(m); m++) segs.push(byMsn.get(m));
    if (segs.length < cfg.archiveSegments || segs[0].pdtMs == null) break;
    buckets.unshift(bucketRecord(segs));
  }
  return { v: 1, n: cfg.archiveSegments, k, buckets };
}

function bucketRecord(segs) {
  const first = segs[0], last = segs.at(-1);
  return {
    a: first.msn,
    b: last.msn,
    dsn: first.dsn,
    pdt: iso(first.pdtMs),
    s: Math.floor(first.pdtMs / 1000) - 1,
    e: Math.floor(last.pdtMs / 1000) + 1,
    dur: rle(segs.map((s) => s.dur)),
    dr: segs.flatMap((s) => s.pre.filter((l) => l.startsWith('#EXT-X-DATERANGE:')).map((l) => [s.msn - first.msn, l])),
  };
}

export function archivedDateranges(table, firstMsn) {
  return table.buckets.flatMap((bk) => (bk.dr ?? []).filter(([off]) => bk.a + off >= firstMsn).map(([, line]) => line));
}

export function rle(values) {
  const out = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && last[0] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out;
}

export const expandRle = (pairs) => pairs.flatMap(([v, n]) => Array(n).fill(v));

// The MSN playing at a time. Before the table it is the first MSN; after it, one past the last.
export function msnAtTime(table, ms) {
  for (const bk of table.buckets) {
    let t = Date.parse(bk.pdt);
    let msn = bk.a;
    if (ms < t) return msn;
    for (const [d, count] of bk.dur) {
      if (ms < t + d * 1000 * count) return msn + Math.floor((ms - t) / (d * 1000));
      t += d * 1000 * count;
      msn += count;
    }
  }
  return table.buckets.length ? table.buckets.at(-1).b + 1 : 0;
}

// One EXT-X-ARCHIVE tag per bucket in the window. The window starts at the segment playing
// presentationSeconds before the live edge, found by time rather than by a segment count, so
// renditions with different segment durations reach back equally far. The oldest archive is
// trimmed with FIRST-MSN, and its DURATION and START-PROGRAM-DATE follow. DURATION leaves out the
// segments still in the live playlist, which starts at liveFirst, so a new archive starts at 0 s.
export function archiveTags(table, liveLast, name, cfg, { liveEndMs = null, liveFirst = liveStartMsn(liveLast, cfg) } = {}) {
  const newest = newestPublished(liveLast, cfg);
  const start = liveEndMs != null ? msnAtTime(table, liveEndMs - cfg.presentationSeconds * 1000) : presentationStart(liveLast, cfg);
  const sum = (xs) => xs.reduce((acc, d) => acc + d, 0);
  const tags = [];
  for (const bk of table.buckets) {
    if (bucketOf(bk.a, cfg) > newest) break;
    const first = Math.max(bk.a, start);
    if (first > bk.b) continue;
    const durs = expandRle(bk.dur);
    const skipped = first - bk.a;
    const archived = Math.max(0, Math.min(bk.b, liveFirst - 1) - first + 1);
    tags.push({
      first,
      last: bk.b,
      duration: sum(durs.slice(skipped, skipped + archived)),
      pdtMs: Date.parse(bk.pdt) + sum(durs.slice(0, skipped)) * 1000,
      uri: archiveName(name, bk),
    });
  }
  return tags;
}

export const formatArchiveTag = (t) =>
  `#EXT-X-ARCHIVE:FIRST-MSN=${t.first},DURATION=${t.duration.toFixed(3)},START-PROGRAM-DATE="${iso(t.pdtMs)}",URI="${t.uri}"`;
