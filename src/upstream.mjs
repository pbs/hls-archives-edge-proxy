// Reading the origin. cfg carries the fetch to use and an optional observer of every request.

import { parseMediaPlaylist } from './playlist.mjs';
import { originUrls } from './origins.mjs';

export class UpstreamError extends Error {
  constructor(status, url) {
    super(`upstream ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

export async function fetchText(url, cfg) {
  const t0 = Date.now();
  const res = await (cfg.fetchImpl ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(cfg.upstreamTimeoutMs ?? 8000) });
  const body = await res.text();
  cfg.onRequest?.({ url, status: res.status, bytes: body.length, ms: Date.now() - t0, body, cache: res.headers.get('x-cache') });
  if (!res.ok) throw new UpstreamError(res.status, url);
  return {
    body,
    contentType: res.headers.get('content-type') ?? 'application/vnd.apple.mpegurl',
    cacheControl: res.headers.get('cache-control') ?? 'max-age=2',
  };
}

export async function fetchJson(url, cfg) {
  return JSON.parse((await fetchText(url, cfg)).body);
}

// Every segment between two epoch seconds, read in parallel chunks of at most maxRangeSeconds.
export async function fetchRange(upstream, startSec, endSec, cfg) {
  const chunks = [];
  for (let s = startSec; s < endSec; s += cfg.maxRangeSeconds) chunks.push([s, Math.min(s + cfg.maxRangeSeconds, endSec)]);
  const parts = await Promise.all(chunks.map(([s, e]) => fetchChunk(upstream, s, e, cfg)));
  return mergeSegments(parts.flat());
}

// A 4xx means the range starts before what the origin keeps, so move the start forward by halves.
// A 5xx or a timeout means the range is too long for the origin, so split it in two.
async function fetchChunk(upstream, s, e, cfg) {
  try {
    return parseMediaPlaylist((await fetchText(originUrls(cfg).range(upstream, s, e), cfg)).body).segments;
  } catch (err) {
    const tooBig = err.name === 'TimeoutError' || (err instanceof UpstreamError && err.status >= 500);
    const tooOld = err instanceof UpstreamError && err.status < 500;
    if (!(tooBig || tooOld) || e - s < 600) throw err;
    const mid = Math.floor((s + e) / 2);
    if (tooBig) return (await Promise.all([fetchChunk(upstream, s, mid, cfg), fetchChunk(upstream, mid, e, cfg)])).flat();
    return fetchChunk(upstream, mid, e, cfg);
  }
}

// Chunks overlap by a segment. Keep each MSN once, and only the unbroken run up to the newest.
export function mergeSegments(segments) {
  const byMsn = new Map();
  for (const s of segments) if (!byMsn.has(s.msn)) byMsn.set(s.msn, s);
  const sorted = [...byMsn.values()].sort((x, y) => x.msn - y.msn);
  let start = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].msn !== sorted[i - 1].msn + 1) start = i;
  return sorted.slice(start);
}
