#!/usr/bin/env node
// Runs the edge function locally against a live stream and checks every rendition's playlist and
// archives. It only reads.
//
//   node scripts/check.mjs <multivariant-url> [--window 2h] [--origin mediapackage|unified]

import { createLoopback } from '../src/loopback.mjs';
import { parseMediaPlaylist } from '../src/playlist.mjs';

const [url, ...rest] = process.argv.slice(2);
if (!url) { console.error('usage: node scripts/check.mjs <multivariant-url> [--window 2h] [--origin mediapackage|unified]'); process.exit(2); }
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

const u = new URL(url);
const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
const mvName = u.pathname.slice(dir.length).replace(/\.m3u8$/, '');
const overrides = opt('--origin') ? { origin: opt('--origin') } : {};
const infix = opt('--window') ?? '';

let upstreamBytes = 0, upstreamRequests = 0, largest = { bytes: 0 };
const loop = createLoopback({
  ...overrides,
  onRequest: (r) => {
    if (/\.arch\./.test(r.url)) return;
    upstreamBytes += r.bytes; upstreamRequests++;
    if (r.bytes > largest.bytes) largest = r;
  },
});

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };
const get = async (name) => { const r = await loop.fetch(`https://${u.host}${dir}${name}`); return { status: r.status, text: await r.text(), cache: r.headers.get('x-cache') }; };
// Child URIs may sit in a subdirectory (Unified Origin's keyframes/); the table name
// derives from the child's bare name within its own directory.
const tagsOf = (text) => [...text.matchAll(/^#EXT-X-ARCHIVE:(.*)$/gm)].map(([, a]) => ({
  first: +a.match(/FIRST-MSN=(\d+)/)[1], duration: +a.match(/DURATION=([\d.]+)/)[1], uri: a.match(/URI="([^"]+)"/)[1],
  pdt: a.match(/START-PROGRAM-DATE="([^"]+)"/)[1],
  a: +a.match(/\.(\d+)-\d+\.\d+-\d+\.m3u8a"/)[1], b: +a.match(/\.\d+-(\d+)\.\d+-\d+\.m3u8a"/)[1],
}));

const mvArch = `${mvName}.arch${infix ? `.${infix}` : ''}.m3u8`;
const mv = await get(mvArch);
const children = [...mv.text.matchAll(/^([^#\s]+\.arch(?:\.[^./]+)?\.m3u8)$|URI="([^"]+\.arch(?:\.[^./]+)?\.m3u8)"/gm)].map((m) => m[1] ?? m[2]);
console.log(`${url}\nmultivariant: ${mv.status}, ${children.length} child playlists\n`);
check(mv.status === 200 && children.length > 0, 'multivariant');

const summary = [];
for (const child of children) {
  // Archive and table URIs are relative to the child's own directory (Unified Origin keeps
  // I-frame playlists under keyframes/).
  const childDir = child.includes('/') ? child.slice(0, child.lastIndexOf('/') + 1) : '';
  const name = child.replace(/\.arch(?:\.[^./]+)?\.m3u8$/, '');
  const t0 = Date.now();
  const live = await get(child);
  const ms = Date.now() - t0;
  const pl = parseMediaPlaylist(live.text);
  const tags = tagsOf(live.text);
  console.log(`${name}: ${live.status} in ${ms} ms, ${live.text.length} bytes, ${pl.segments.length} live segments, ${tags.length} archives`);
  check(live.status === 200 && tags.length > 0, `${name}: playlist with archives`);
  if (!tags.length) continue;

  const L = pl.segments.at(-1).msn;
  check(live.text.lastIndexOf('#EXT-X-ARCHIVE') < live.text.indexOf('#EXTINF'), `${name}: tags precede first segment`);
  for (let i = 1; i < tags.length; i++) check(tags[i].first === tags[i - 1].b + 1, `${name}: archive ${i} contiguous`);
  for (let i = 1; i < pl.segments.length; i++) check(pl.segments[i].msn === pl.segments[i - 1].msn + 1, `${name}: live MSNs contiguous`);
  check(pl.segments[0].msn <= tags.at(-1).b + 1, `${name}: live playlist continues from the newest archive`);
  check(pl.segments[0].msn >= tags.at(-1).a, `${name}: live playlist does not reach back past the newest archive`);

  const archived = tags.reduce((s, t) => s + t.duration, 0);
  const liveDur = pl.segments.reduce((s, x) => s + x.dur, 0);
  const dateranges = live.text.split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE'));
  console.log(`  presentation ≈ ${((archived + liveDur) / 3600).toFixed(2)} h: archives ${tags[0].first}..${tags.at(-1).b}, live ${pl.segments[0].msn}..${L}; ${dateranges.length} DATERANGE tags (${new Set(dateranges).size} distinct)`);
  check(dateranges.length === new Set(dateranges).size, `${name}: no duplicate DATERANGE lines`);
  const reach = (pl.segments.at(-1).pdtMs + pl.segments.at(-1).dur * 1000 - Date.parse(tags[0].pdt)) / 1000;
  check(Math.abs(archived + liveDur - reach) < 1, `${name}: DURATIONs and the live playlist add up to the window (${(archived + liveDur).toFixed(3)} vs ${reach.toFixed(3)} s)`);
  const lastSeg = pl.segments.at(-1);
  const targetDuration = Number(live.text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] ?? 0);
  summary.push({ name, archived, targetDuration, reachSeconds: (lastSeg.pdtMs + lastSeg.dur * 1000 - Date.parse(tags[0].pdt)) / 1000, bytes: live.text.length });

  // A second refresh, as a player would do it: the table and archives are cache hits now.
  await new Promise((r) => setTimeout(r, 2100));
  const t2 = Date.now();
  const again = await get(child);
  console.log(`  refresh: ${again.status} in ${Date.now() - t2} ms, ${again.text.length} bytes (${again.cache})`);

  for (const [label, tag] of [['newest', tags.at(-1)], ['oldest', tags[0]]]) {
    const t1 = Date.now();
    const arc = await get(childDir + tag.uri);
    const segs = parseMediaPlaylist(arc.text).segments;
    // DURATION counts the archive's segments from FIRST-MSN that are not in the live playlist.
    const kept = segs.filter((s) => s.msn >= tag.first && s.msn < pl.segments[0].msn);
    const sum = kept.reduce((acc, s) => acc + s.dur, 0);
    console.log(`  ${label}: ${arc.status} in ${Date.now() - t1} ms, ${arc.text.length} bytes, MSN ${segs[0]?.msn}..${segs.at(-1)?.msn}, sum before the live playlist ${sum.toFixed(3)} vs DURATION ${tag.duration.toFixed(3)}`);
    check(arc.status === 200, `${name} ${label}: status`);
    check(/^#EXT-X-MEDIA-SEQUENCE:\d+\n#EXT-X-DISCONTINUITY-SEQUENCE:\d+\n/.test(arc.text), `${name} ${label}: starts with the sequence tags`);
    const beforeFirst = arc.text.slice(0, arc.text.indexOf(segs[0]?.uri ?? '\u0000'));
    check(/#EXT-X-PROGRAM-DATE-TIME:/.test(beforeFirst), `${name} ${label}: PDT precedes the first segment`);
    check(!/#EXT-X-MAP:/.test(arc.text) || /#EXT-X-MAP:/.test(beforeFirst), `${name} ${label}: MAP precedes the first segment`);
    check(!/EXTM3U|ENDLIST|PLAYLIST-TYPE|DATERANGE|TARGETDURATION/.test(arc.text), `${name} ${label}: only segment tags`);
    check(segs.length && segs[0].msn === tag.a && segs.at(-1).msn === tag.b, `${name} ${label}: exact range ${tag.a}..${tag.b}`);
    check(Math.abs(sum - tag.duration) < 0.001, `${name} ${label}: DURATION matches`);
  }
  const tableUri = `${name}.arch.${tags.at(-1).a}-${tags.at(-1).b}.json`;   // name already includes childDir
  const table = await get(tableUri);
  check(table.status === 200, `${name}: table`);
  if (table.status === 200) console.log(`  table: ${table.text.length} bytes, ${JSON.parse(table.text).buckets.length} buckets`);
}

if (summary.length > 1) {
  // Renditions are fetched one after another, so their live edges differ by a segment or
  // two. What must agree is how far back in time each reaches from its own live edge: the
  // same presentation length, to within a segment of each rendition.
  const reaches = summary.map((r) => r.reachSeconds);
  const spread = Math.max(...reaches) - Math.min(...reaches);
  const targetDuration = Math.max(...summary.map((r) => r.targetDuration));
  check(spread <= targetDuration, `renditions reach back by times that differ by ${spread.toFixed(3)} s (target duration ${targetDuration} s)`);
  const min = Math.min(...summary.map((r) => r.archived)), max = Math.max(...summary.map((r) => r.archived));
  console.log(`\narchived duration across ${summary.length} renditions: ${min.toFixed(3)}..${max.toFixed(3)} s; each reaches back ${Math.min(...reaches).toFixed(1)}..${Math.max(...reaches).toFixed(1)} s from its live edge`);
}
console.log(`upstream: ${upstreamRequests} requests, ${(upstreamBytes / 1e6).toFixed(1)} MB; largest ${(largest.bytes / 1e3).toFixed(0)} KB from ${largest.url?.replace(/^https:\/\/[^/]+/, '')}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
