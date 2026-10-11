import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMediaPlaylist, serializeMediaPlaylist, serializeArchive, rewriteMultivariant, isMultivariant } from '../src/playlist.mjs';
import { makeTimeline, fakeMediaPackage } from './fake-origin.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const withoutVodTags = (text) => text.split('\n').filter((l) => l && !/^#EXT-X-(PLAYLIST-TYPE|ENDLIST)/.test(l)).join('\n') + '\n';
const uris = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

// An hour of the synthetic stream, with its ad breaks, as a MediaPackage start/end range.
async function syntheticHour() {
  const timeline = makeTimeline({ count: 600 });
  const { fetchImpl } = fakeMediaPackage(timeline);
  const from = Math.floor(timeline[0].startMs / 1000), to = Math.floor(timeline.at(-1).startMs / 1000);
  return (await fetchImpl(`https://mp.test/live/ch/v.m3u8?start=${from}&end=${to}`)).text();
}

test('round-trips a playlist with SCTE-35 conditioning byte for byte', async () => {
  const src = await syntheticHour();
  assert.match(src, /#EXT-X-CUE-OUT:/);
  assert.equal(serializeMediaPlaylist(parseMediaPlaylist(src)), withoutVodTags(src));
});

test('derives a PDT for every segment from sparse PDT lines', async () => {
  const pl = parseMediaPlaylist(await syntheticHour());
  const explicit = pl.segments.filter((s) => s.pre.some((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME')));
  assert.ok(explicit.length > 1 && explicit.length < pl.segments.length);
  for (const s of pl.segments) assert.equal(typeof s.pdtMs, 'number');
  for (const s of explicit) {
    const prev = pl.segments[pl.segments.indexOf(s) - 1];
    if (prev) assert.ok(Math.abs(prev.pdtMs + prev.dur * 1000 - s.pdtMs) <= 1, `drift at ${s.msn}`);
  }
});

test('an archive cut inside an ad break stands on its own and carries only segment tags', async () => {
  const pl = parseMediaPlaylist(await syntheticHour());
  const cue = pl.segments.findIndex((s) => s.pre.some((l) => l.startsWith('#EXT-X-CUE-OUT:')));
  const segs = pl.segments.slice(cue + 3, cue + 103);
  const out = serializeArchive(segs);
  const head = out.split('\n');
  assert.equal(head[0], `#EXT-X-MEDIA-SEQUENCE:${segs[0].msn}`);
  assert.equal(head[1], `#EXT-X-DISCONTINUITY-SEQUENCE:${segs[0].dsn}`);
  assert.match(head[2], /^#EXT-X-PROGRAM-DATE-TIME:/);
  assert.ok(out.indexOf('#EXT-X-CUE-OUT-CONT') < out.indexOf(segs[0].uri), 'break state precedes the first segment');
  assert.doesNotMatch(out, /EXTM3U|EXT-X-DATERANGE|ENDLIST|TARGETDURATION|PLAYLIST-TYPE/);
  assert.deepEqual(uris(out), segs.map((s) => s.uri));
});

test('a trimmed playlist repeats MAP and KEY, drops a leading DISCONTINUITY and bumps the DSN', () => {
  const src = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:10', '#EXT-X-DISCONTINUITY-SEQUENCE:3',
    '#EXT-X-PROGRAM-DATE-TIME:2026-10-08T00:00:00.000Z', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k1"', '#EXT-X-MAP:URI="a.mp4"',
    '#EXTINF:4,', 's10.mp4',
    '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="b.mp4"', '#EXT-X-DATERANGE:ID="x",START-DATE="2026-10-08T00:00:04.000Z"', '#EXTINF:4,', 's11.mp4',
    '#EXTINF:4,', 's12.mp4', '',
  ].join('\n');
  const pl = parseMediaPlaylist(src);

  const fromDisc = serializeMediaPlaylist(pl, { from: 1 });
  assert.match(fromDisc, /^#EXT-X-MEDIA-SEQUENCE:11\n#EXT-X-DISCONTINUITY-SEQUENCE:4\n/m);
  assert.doesNotMatch(fromDisc, /^#EXT-X-DISCONTINUITY\n/m);
  assert.match(fromDisc, /PROGRAM-DATE-TIME:2026-10-08T00:00:04.000Z\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k1"\n#EXT-X-MAP:URI="b.mp4"\n#EXT-X-DATERANGE/);

  const afterDisc = serializeMediaPlaylist(pl, { from: 2 });
  assert.match(afterDisc, /#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXT-X-DATERANGE:ID="x"/, 'DATERANGE from a trimmed segment stays in the media playlist');
  assert.match(afterDisc, /#EXT-X-MAP:URI="b.mp4"\n#EXTINF:4,\ns12.mp4/);

  const archive = serializeArchive(pl.segments.slice(1));
  assert.ok(archive.startsWith('#EXT-X-MEDIA-SEQUENCE:11\n#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXT-X-PROGRAM-DATE-TIME:'));
  assert.doesNotMatch(archive, /DATERANGE/);
});

test('Unified Origin playlists: comments and USP tags go, cue tags and DATERANGE stay, archives cut cleanly', () => {
  const live = fixture('unified-live-900s.m3u8');
  const pl = parseMediaPlaylist(live);
  assert.ok(pl.segments.length > 400);
  const out = serializeMediaPlaylist(pl);
  assert.doesNotMatch(out, /^## |^#USP-/m);
  assert.equal(uris(out).length, pl.segments.length);
  assert.equal(out.split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE')).length, live.split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE')).length);
  for (const s of pl.segments) assert.equal(typeof s.pdtMs, 'number');

  const range = parseMediaPlaylist(fixture('unified-range-10m.m3u8'));
  const cue = range.segments.findIndex((s) => s.pre.includes('#EXT-X-CUE-OUT'));
  const slice = cue > 2 ? range.segments.slice(cue - 2, cue + 50) : range.segments.slice(5, 57);
  const arc = serializeArchive(slice);
  assert.ok(arc.startsWith(`#EXT-X-MEDIA-SEQUENCE:${slice[0].msn}\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:`));
  assert.doesNotMatch(arc, /EXTM3U|DATERANGE|ENDLIST|##|USP-X/);
  if (cue > 2) assert.match(arc, /#EXT-X-CUE-OUT\n/);

  const mv = rewriteMultivariant(fixture('unified-multivariant.m3u8'));
  assert.match(mv, /^unified-learning-audio_eng=128000-video=400000\.arch\.m3u8$/m);
  assert.match(mv, /URI="keyframes\/unified-learning-video=400000\.arch\.m3u8"/);
  assert.doesNotMatch(mv, /^## /m);
});

test('rewrites multivariant children and strips their query strings', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="index_audio.m3u8?start=1"',
    '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="en",INSTREAM-ID="CC1"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', 'index_1080p.m3u8?start=1',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="index_1080p_iframe.m3u8"', '',
  ].join('\n');
  assert.ok(isMultivariant(src));
  const out = rewriteMultivariant(src);
  assert.match(out, /URI="index_audio\.arch\.m3u8"/);
  assert.match(out, /^index_1080p\.arch\.m3u8$/m);
  assert.match(out, /URI="index_1080p_iframe\.arch\.m3u8"/);
  assert.match(out, /INSTREAM-ID="CC1"/);
});
