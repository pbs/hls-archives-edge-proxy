// Media playlist parsing and serialization. Segment lines are kept verbatim, and each segment
// records the state it inherits (KEY, MAP, PDT, discontinuity sequence) so that any segment can
// start a playlist or an archive.

const PLAYLIST_TAGS = new Set([
  '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-I-FRAMES-ONLY',
  '#EXT-X-START', '#EXT-X-SERVER-CONTROL', '#EXT-X-PART-INF', '#EXT-X-DEFINE',
]);

// Rewritten or dropped on output.
const CONSUMED_TAGS = new Set([
  '#EXTM3U', '#EXT-X-MEDIA-SEQUENCE', '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-PLAYLIST-TYPE', '#EXT-X-ENDLIST',
]);

// Archives have no date ranges (those stay in the media playlist) and no partial segments.
const NOT_IN_ARCHIVE = ['#EXT-X-DATERANGE', '#EXT-X-PART', '#EXT-X-PRELOAD-HINT', '#EXT-X-RENDITION-REPORT', '#EXT-X-SKIP'];

const tagOf = (line) => line.split(':', 1)[0];
const lines = (...xs) => xs.join('\n') + '\n';
const isDaterange = (line) => line.startsWith('#EXT-X-DATERANGE:');

export const iso = (ms) => new Date(Math.round(ms)).toISOString();
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export function parseMediaPlaylist(text) {
  const header = [];
  const segments = [];
  let msn = 0, dsn = 0, hasDsn = false, map = null, dur = null, pdtMs = null, disc = false, pre = [];
  const keys = new Map();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (!line.startsWith('#')) {
      const prev = segments.at(-1);
      if (pdtMs == null && prev?.pdtMs != null) pdtMs = prev.pdtMs + prev.dur * 1000;
      segments.push({
        msn: msn + segments.length,
        dsn: prev ? prev.dsn + (disc ? 1 : 0) : dsn,
        disc, dur, pdtMs, map,
        keys: [...keys.values()],
        pre,
        uri: line,
      });
      pre = []; dur = null; pdtMs = null; disc = false;
      continue;
    }

    // Comments, such as Unified Origin's "## Created with" and #USP-X-TIMESTAMP-MAP.
    if (!line.startsWith('#EXT')) continue;

    const tag = tagOf(line);
    if (tag === '#EXT-X-MEDIA-SEQUENCE') msn = parseInt(line.slice(tag.length + 1), 10);
    else if (tag === '#EXT-X-DISCONTINUITY-SEQUENCE') { dsn = parseInt(line.slice(tag.length + 1), 10); hasDsn = true; }
    else if (CONSUMED_TAGS.has(tag)) continue;
    else if (PLAYLIST_TAGS.has(tag)) header.push(line);
    else {
      pre.push(line);
      if (tag === '#EXTINF') dur = parseFloat(line.slice(8));
      else if (tag === '#EXT-X-PROGRAM-DATE-TIME') pdtMs = Date.parse(line.slice(25));
      else if (tag === '#EXT-X-DISCONTINUITY') disc = true;
      else if (tag === '#EXT-X-MAP') map = line;
      else if (tag === '#EXT-X-KEY') trackKey(keys, line);
    }
  }
  // hasDsn: whether the origin writes EXT-X-DISCONTINUITY-SEQUENCE at all (Unified Virtual Channel doesn't).
  return { header, segments, trailing: pre, hasDsn };
}

function trackKey(keys, line) {
  if (/METHOD=NONE/.test(line)) keys.clear();
  else keys.set(line.match(/KEYFORMAT="([^"]*)"/)?.[1] ?? 'identity', line);
}

// The media playlist from segment index `from`, with EXT-X-ARCHIVE tags ahead of the first segment.
// The date ranges of archived and trimmed segments come first, once each.
export function serializeMediaPlaylist(pl, { from = 0, archiveTags = [], dateranges = [] } = {}) {
  const segs = pl.segments.slice(from);
  const first = segs[0];
  const inPlace = new Set(segs.flatMap((s) => s.pre.filter(isDaterange)));
  const hoisted = [...new Set([...dateranges, ...pl.segments.slice(0, from).flatMap((s) => s.pre.filter(isDaterange))])]
    .filter((l) => !inPlace.has(l));
  return lines(
    '#EXTM3U',
    ...pl.header,
    `#EXT-X-MEDIA-SEQUENCE:${first.msn}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${pl.hasDsn ? first.dsn : 0}`,
    ...archiveTags,
    ...hoisted,
    ...segmentLines(segs, { hasDsn: pl.hasDsn }),
    ...pl.trailing,
  );
}

// A Playlist Archive: the two sequence tags, then segments. No #EXTM3U, as in the proposal's example.
export function serializeArchive(segments, { hasDsn = true } = {}) {
  const first = segments[0];
  return lines(
    `#EXT-X-MEDIA-SEQUENCE:${first.msn}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${hasDsn ? first.dsn : 0}`,
    ...segmentLines(segments, { archive: true, hasDsn }),
  );
}

function segmentLines(segments, { archive = false, hasDsn = true } = {}) {
  const out = [];
  segments.forEach((s, i) => {
    let pre = archive ? s.pre.filter((l) => !NOT_IN_ARCHIVE.some((t) => l.startsWith(t))) : s.pre;
    if (i === 0) pre = leadIn(s, pre, hasDsn);
    out.push(...pre, s.uri);
  });
  return out;
}

// The first segment gets the PDT, KEY and MAP it inherits. Its EXT-X-DISCONTINUITY goes, since the
// discontinuity sequence counts it, unless the origin writes no discontinuity sequence.
function leadIn(s, pre, hasDsn) {
  if (hasDsn) pre = pre.filter((l) => l !== '#EXT-X-DISCONTINUITY');
  const lead = [];
  if (s.pdtMs != null && !pre.some((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME'))) lead.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(s.pdtMs)}`);
  for (const k of s.keys) if (!pre.includes(k)) lead.push(k);
  if (s.map && !pre.includes(s.map)) lead.push(s.map);
  return [...lead, ...pre];
}

export const isMultivariant = (text) => /^#EXT-X-(STREAM-INF|MEDIA):/m.test(text);

// Point every child playlist at its .arch twin with the same window, dropping the query strings
// origins append and the comment lines.
export function rewriteMultivariant(text, infix = '') {
  const twin = `.arch${infix ? `.${infix}` : ''}.m3u8`;
  return text.split(/\r?\n/)
    .filter((line) => !line.startsWith('#') || line.startsWith('#EXT'))
    .map((line) => (line.startsWith('#')
      ? line.replace(/URI="([^"?]+)\.m3u8[^"]*"/g, `URI="$1${twin}"`)
      : line.replace(/^([^?#\s]+)\.m3u8\S*$/, `$1${twin}`))).join('\n');
}
