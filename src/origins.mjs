// How to ask each origin for its live playlist and for a time range. Both number segments the
// same way in every response, which is all the rest of the proxy relies on.

import { liveTailStart } from './archives.mjs';

export const origins = {
  mediapackage: {
    tail: (upstream, cfg, nowSec) => `${upstream}?start=${liveTailStart(nowSec, cfg)}`,
    range: (upstream, s, e) => `${upstream}?start=${s}&end=${e}`,
    // MediaPackage serves at most 24 h per request.
    maxRangeSeconds: 20 * 3600,
  },
  unified: {
    tail: (upstream, cfg) => `${upstream}?dvr_window_length=${cfg.liveTailSeconds}`,
    // ISO with a Z is the one form both Unified Origin and Unified Virtual Channel accept.
    range: (upstream, s, e) => `${upstream}?vbegin=${isoZ(s)}&vend=${isoZ(e)}`,
    // Unified Origin refuses ranges of 10 h and more, and Virtual Channel is slow on long ones.
    maxRangeSeconds: 3600,
  },
};

const isoZ = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function resolveOrigin(path, cfg) {
  if (cfg.origin && cfg.origin !== 'auto') return cfg.origin;
  return /\.isml?\//.test(path) ? 'unified' : 'mediapackage';
}

export function withOrigin(path, cfg) {
  const origin = resolveOrigin(path, cfg);
  return { ...cfg, origin, maxRangeSeconds: cfg.maxRangeSeconds ?? origins[origin].maxRangeSeconds };
}

export const originUrls = (cfg) => origins[cfg.origin];
