// Lambda@Edge has no environment variables, so the settings ship in this file.
export const defaults = {
  // 'mediapackage', 'unified', or 'auto' (Unified Origin when the path has an .ism/.isml element).
  origin: 'auto',

  // Segments per archive. 'auto' sizes archives to about archiveSeconds from the median segment
  // duration. Pin it for a stream whose segment durations are bimodal, so every edge agrees.
  archiveSegments: 'auto',
  archiveSeconds: 600,

  // An archive is listed once the live edge is this many segments past its last segment.
  marginSegments: 8,

  // The window when the URL names none, and the longest one it may name.
  presentationSeconds: 2 * 3600,
  maxPresentationSeconds: 24 * 3600,

  // How far back the live playlist is read, and the rounding of that start, so that every
  // viewer's refresh shares one upstream URL for ten minutes.
  liveTailSeconds: 900,
  liveTailQuantumSeconds: 600,

  tableCacheSeconds: 3600,
  archiveCacheSeconds: 86400,

  // Where the origin's playlists are read. null is the distribution's own domain.
  upstreamHost: null,
  upstreamTimeoutMs: 8000,
};
