import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/loopback.mjs';
import { createHandler } from '../src/handler.mjs';
import { parseMediaPlaylist } from '../src/playlist.mjs';
import { makeTimeline, fakeMediaPackage } from './fake-origin.mjs';

const cfg = { archiveSegments: 100, marginSegments: 8, archiveCount: 24, presentationSeconds: 4 * 3600, upstreamHost: 'mp.test' }; // ≈ 2400 segments
const DIR = 'https://mp.test/live/ch/';

const archiveTagsOf = (text) => [...text.matchAll(/^#EXT-X-ARCHIVE:(.*)$/gm)].map(([, attrs]) => ({
  first: Number(attrs.match(/FIRST-MSN=(\d+)/)[1]),
  duration: Number(attrs.match(/DURATION=([\d.]+)/)[1]),
  pdt: attrs.match(/START-PROGRAM-DATE="([^"]+)"/)[1],
  uri: attrs.match(/URI="([^"]+)"/)[1],
}));
const msnsOf = (text) => parseMediaPlaylist(text).segments.map((s) => s.msn);

async function session(timelineOpts = {}) {
  const timeline = makeTimeline({ count: 3200, ...timelineOpts }); // ~5.3 h of 6 s segments
  const mp = fakeMediaPackage(timeline);
  const loop = createLoopback({ ...cfg, fetchImpl: mp.fetchImpl });
  const get = async (uri) => { const r = await loop.fetch(DIR + uri); return { status: r.status, text: await r.text(), cache: r.headers.get('x-cache'), cc: r.headers.get('cache-control') }; };
  return { timeline, mp, loop, get };
}

test('multivariant: children point at their .arch twins, start= stripped', async () => {
  const { get } = await session();
  const mv = await get('index.arch.m3u8');
  assert.equal(mv.status, 200);
  assert.match(mv.text, /URI="a\.arch\.m3u8"/);
  assert.match(mv.text, /^v\.arch\.m3u8$/m);
  assert.doesNotMatch(mv.text, /start=/);
});

test('media playlist, table and archives agree with each other and with the source', async () => {
  const { timeline, mp, get } = await session();
  const live = await get('v.arch.m3u8');
  assert.equal(live.status, 200);
  assert.equal(live.cc, 'max-age=2');

  const tags = archiveTagsOf(live.text);
  const liveMsns = msnsOf(live.text);
  const L = liveMsns.at(-1);
  // The presentation is archiveCount archives long including the live tail, so the tail
  // displaces most of one archive: 23 or 24 tags depending on alignment.
  assert.ok(tags.length === cfg.archiveCount || tags.length === cfg.archiveCount - 1, `a full presentation (${tags.length} tags)`);
  assert.ok(live.text.lastIndexOf('#EXT-X-ARCHIVE') < live.text.indexOf('#EXTINF'), 'tags precede the first segment');
  assert.doesNotMatch(live.text, /PLAYLIST-TYPE|ENDLIST/);
  assert.equal(liveMsns.length, cfg.archiveSegments + cfg.marginSegments);
  assert.ok(liveMsns[0] <= tagLast(tags.at(-1)) + 1, 'live playlist continues from the newest archive');

  // Archives carry no DATERANGE, so the media playlist carries every date range of the whole
  // presentation (archived content included), each exactly once, all ahead of the segments.
  const expected = timeline.filter((s) => s.msn >= tags[0].first && s.msn <= L).flatMap((s) => s.pre.filter((l) => l.startsWith('#EXT-X-DATERANGE')));
  const emitted = live.text.split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE'));
  assert.deepEqual(emitted, expected, 'date ranges of the presentation, oldest first, once each');
  assert.ok(expected.length >= 4, `the synthetic presentation has ${expected.length} ad breaks`);

  // Every segment of the presentation is counted exactly once: by an archive's DURATION from
  // FIRST-MSN up to the live playlist, or by the live playlist.
  const presented = new Set(liveMsns);
  for (const tag of tags) {
    const arc = await get(tag.uri);
    assert.equal(arc.status, 200, tag.uri);
    assert.equal(arc.cc, 'public, max-age=86400');
    const segs = parseMediaPlaylist(arc.text).segments;
    assert.equal(segs.length, cfg.archiveSegments);
    assert.ok(arc.text.startsWith(`#EXT-X-MEDIA-SEQUENCE:${segs[0].msn}\n#EXT-X-DISCONTINUITY-SEQUENCE:${segs[0].dsn}\n`));
    const beforeFirst = arc.text.slice(0, arc.text.indexOf(segs[0].uri));
    assert.match(beforeFirst, /#EXT-X-PROGRAM-DATE-TIME:/, 'PDT precedes the first segment');
    assert.doesNotMatch(arc.text, /EXTM3U|DATERANGE|ENDLIST|PLAYLIST-TYPE/);
    const kept = segs.filter((s) => s.msn >= tag.first && s.msn < liveMsns[0]);
    assert.ok(Math.abs(kept.reduce((acc, s) => acc + s.dur, 0) - tag.duration) < 1e-6, 'DURATION is the exact sum from FIRST-MSN to the live playlist');
    assert.equal(tag.pdt, new Date(timeline.find((s) => s.msn === tag.first).startMs).toISOString(), 'START-PROGRAM-DATE is the real PDT');
    for (const s of kept) { assert.ok(!presented.has(s.msn), `duplicate ${s.msn}`); presented.add(s.msn); }
    // MAP before the first segment is the right init segment for that period.
    const expectedMap = timeline.find((s) => s.msn === segs[0].msn).map;
    assert.match(beforeFirst, new RegExp(`#EXT-X-MAP:URI="${expectedMap}"`));
  }
  const first = tags[0].first;
  for (let m = first; m <= L; m++) assert.ok(presented.has(m), `missing ${m}`);
  assert.equal(presented.size, L - first + 1);

  // The discontinuity is inside some archive: it carries the tag and the DSN math is right.
  const disc = timeline.find((s) => s.disc);
  const holder = tags.find((t) => t.first <= disc.msn && tagLast(t) >= disc.msn) ?? null;
  if (holder) {
    const arc = parseMediaPlaylist((await get(holder.uri)).text);
    const seg = arc.segments.find((s) => s.msn === disc.msn);
    assert.equal(seg.dsn, arc.segments[0].dsn + (seg.msn === arc.segments[0].msn ? 0 : 1));
  }

  // The table build is the only long read; archive fetches are ten-minute ranges.
  const long = mp.calls.filter((u) => { const m = u.match(/start=(\d+)&end=(\d+)/); return m && m[2] - m[1] > 3600; });
  assert.ok(long.length >= 1 && long.length <= 2, `table build used ${long.length} long range requests`);
});

test('refreshing is cheap: table and archives are cache hits, only the live tail is refetched', async () => {
  const { mp, get } = await session();
  await get('v.arch.m3u8');
  const before = mp.calls.length;
  const again = await get('v.arch.m3u8');
  assert.equal(again.cache, 'Hit from loopback');
  await new Promise((r) => setTimeout(r, 2100));
  const refreshed = await get('v.arch.m3u8');
  assert.equal(refreshed.cache, 'Miss from loopback');
  assert.equal(mp.calls.length - before, 1, 'exactly one upstream request for the refresh');
  assert.match(mp.calls.at(-1), /v\.m3u8\?start=\d+$/);
});

test('a young stream gets as many archives as exist, with no gaps', async () => {
  const { get } = await session({ count: 700 }); // ~70 min, presentation wants 4 h
  const live = await get('v.arch.m3u8');
  const tags = archiveTagsOf(live.text);
  assert.ok(tags.length >= 4 && tags.length < cfg.archiveCount);
  for (let i = 1; i < tags.length; i++) assert.equal(tags[i].first, tagLast(tags[i - 1]) + 1);
});

test('a window in the name sets the presentation length and rides along to children', async () => {
  const { get } = await session();
  // The archives' DURATIONs and the live playlist add up to the window, give or take a segment.
  const total = (text) => archiveTagsOf(text).reduce((s, t) => s + t.duration, 0) + parseMediaPlaylist(text).segments.reduce((s, x) => s + x.dur, 0);
  const twoText = (await get('v.arch.2h.m3u8')).text, halfText = (await get('v.arch.30m.m3u8')).text;
  const two = archiveTagsOf(twoText), half = archiveTagsOf(halfText);
  const dflt = archiveTagsOf((await get('v.arch.m3u8')).text);           // presentationSeconds: 4 h here
  assert.ok(half.length < two.length && two.length < dflt.length, `${half.length} < ${two.length} < ${dflt.length}`);
  assert.ok(total(twoText) >= 7200 - 1e-6 && total(twoText) < 7200 + 7, `two hours (${total(twoText)})`);
  assert.ok(total(halfText) >= 1800 - 1e-6 && total(halfText) < 1800 + 7, `half an hour (${total(halfText)})`);
  const capped = archiveTagsOf((await get('v.arch.99h.m3u8')).text);
  assert.ok(capped.length <= cfg.archiveCount + 1, 'clamped to maxPresentationSeconds and to what the table holds');

  const mv = await get('index.arch.6h.m3u8');
  assert.match(mv.text, /^v\.arch\.6h\.m3u8$/m);
  assert.match(mv.text, /URI="a\.arch\.6h\.m3u8"/);
  assert.equal((await get('v.arch.tomorrow.m3u8')).status, 404, 'unknown infix is not ours');
});

test("archiveSegments 'auto' sizes archives to about ten minutes of the stream", async () => {
  const timeline = makeTimeline({ count: 1500 });
  const mp = fakeMediaPackage(timeline);
  const depths = [];
  const loop = createLoopback({ upstreamHost: 'mp.test', archiveCount: 6, archiveSegments: 'auto', fetchImpl: mp.fetchImpl, onRequest: (r) => depths.push([r.depth, r.url.replace(DIR, '')]) });
  const text = await (await loop.fetch(`${DIR}v.arch.m3u8`)).text();
  const tags = archiveTagsOf(text);
  assert.ok(tags.length >= 5);
  for (const t of tags) assert.equal(tagLast(t) - Number(t.uri.match(/\.arch\.(\d+)-/)[1]) + 1, 100, '600 s / 6.006 s ≈ 100 segments');
  const arc = await loop.fetch(`${DIR}${tags[2].uri}`);
  assert.equal(arc.status, 200);
  // Nesting: the handler's fetches are depth 1, the table handler's fetches depth 2.
  assert.deepEqual(depths.map(([d]) => d).sort(), [1, 1, 1, 2, 2, 2].slice(0, depths.length).sort());
  assert.ok(depths.some(([d, u]) => d === 2 && /&end=/.test(u)), 'the long read happens inside the table build');
});

test('Unified Origin dialect: dvr_window_length for the tail, vbegin/vend for ranges, empty multivariant name', async () => {
  const timeline = makeTimeline({ count: 1500 });
  // channel.isml/.m3u8, and an origin that refuses ranges over 30 minutes (the real one refuses 10 h).
  const mp = fakeMediaPackage(timeline, { multivariant: '', maxRangeSeconds: 1800 });
  const loop = createLoopback({ upstreamHost: 'usp.test', archiveSegments: 100, archiveCount: 6, presentationSeconds: 3600, fetchImpl: mp.fetchImpl });
  const dir = 'https://usp.test/live/channel.isml/';

  const mv = await (await loop.fetch(`${dir}.arch.m3u8`)).text();
  assert.match(mv, /^v\.arch\.m3u8$/m);
  const text = await (await loop.fetch(`${dir}v.arch.m3u8`)).text();
  const tags = archiveTagsOf(text);
  assert.ok(tags.length >= 5);
  const arc = await loop.fetch(`${dir}${tags.at(-1).uri}`);
  assert.equal(arc.status, 200);

  assert.ok(mp.calls.every((u) => !/[?&](start|end)=/.test(u)), 'never speaks MediaPackage to a Unified Origin');
  assert.ok(mp.calls.some((u) => /\?dvr_window_length=900$/.test(u)), 'live tail by window length');
  const ranges = mp.calls.map((u) => u.match(/\?vbegin=(\S+?)&vend=(\S+)$/)).filter(Boolean).map((m) => (Date.parse(m[2]) - Date.parse(m[1])) / 1000);
  assert.ok(ranges.length >= 3 && ranges.some((r) => r > 1800) && ranges.some((r) => r <= 1800), 'a refused long range was split and retried');
  assert.ok(ranges.length && mp.calls.filter((u) => /vbegin=/.test(u)).every((u) => /vbegin=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ&vend=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(u)), 'ISO with Z, whole seconds');
});

test('a range the origin is too slow to serve is split and retried, like a refused one', async () => {
  const timeline = makeTimeline({ count: 1500 });
  const mp = fakeMediaPackage(timeline, { multivariant: '', slowAboveSeconds: 1800 });
  const loop = createLoopback({ upstreamHost: 'usp.test', archiveSegments: 100, archiveCount: 6, presentationSeconds: 3600, upstreamTimeoutMs: 100, fetchImpl: mp.fetchImpl });
  const text = await (await loop.fetch('https://usp.test/live/ch.isml/v.arch.m3u8')).text();
  assert.ok(archiveTagsOf(text).length >= 5, 'archives despite the slow long ranges');
  const spans = mp.calls.map((u) => u.match(/vbegin=(\S+?)&vend=(\S+)$/)).filter(Boolean).map((m) => (Date.parse(m[2]) - Date.parse(m[1])) / 1000);
  assert.ok(spans.some((s) => s > 1800) && spans.some((s) => s <= 1800), 'the timed-out range was halved');
});

test('an origin without DISCONTINUITY-SEQUENCE: archives keep a leading DISCONTINUITY and say :0, like the origin', async () => {
  // discAt=1700 puts the discontinuity on MSN 101700, the first segment of a 100-segment bucket.
  const timeline = makeTimeline({ count: 2200, discAt: 1700 });
  const url = (mp) => `https://usp.test/vc/channel.isml/`;
  const withDsn = fakeMediaPackage(timeline), noDsn = fakeMediaPackage(timeline, { dsnTag: false });
  for (const [mp, hasDsn] of [[withDsn, true], [noDsn, false]]) {
    const loop = createLoopback({ ...cfg, archiveSegments: 100, archiveCount: 8, presentationSeconds: 3000, fetchImpl: mp.fetchImpl });
    const live = await (await loop.fetch(`${url(mp)}v.arch.m3u8`)).text();
    const tag = archiveTagsOf(live).find((t) => t.uri.includes('.101700-101799.'));
    assert.ok(tag, 'the bucket starting at the discontinuity is in the presentation');
    const arc = await (await loop.fetch(`${url(mp)}${tag.uri}`)).text();
    const head = arc.split('\n').slice(0, 4);
    if (hasDsn) {
      assert.equal(head[1], '#EXT-X-DISCONTINUITY-SEQUENCE:6', 'DSN counts the discontinuity (base 5 + 1)');
      assert.ok(!head.includes('#EXT-X-DISCONTINUITY'), 'the DSN carries it, so no leading tag');
    } else {
      assert.equal(head[1], '#EXT-X-DISCONTINUITY-SEQUENCE:0', 'mirrors the origin');
      assert.ok(head.includes('#EXT-X-DISCONTINUITY'), 'the leading tag is the only record of the break, so it stays');
    }
    assert.match(live, hasDsn ? /^#EXT-X-DISCONTINUITY-SEQUENCE:[56]$/m : /^#EXT-X-DISCONTINUITY-SEQUENCE:0$/m);
  }
});

test('bad names are refused without touching the origin', async () => {
  const { mp, get } = await session();
  for (const uri of ['v.arch.100050-100149.1-2.m3u8a', 'v.arch.100000-100099.5-4.m3u8a', 'v.arch.100001-100100.json']) {
    assert.equal((await get(uri)).status, 404, uri);
  }
  assert.equal(mp.calls.length, 0);
});

test('anything else passes straight through, but a malformed .arch. name never reaches the origin', async () => {
  const handler = createHandler(cfg);
  const event = (uri) => ({ Records: [{ cf: { config: { distributionDomainName: 'd.test' }, request: { uri, querystring: '', headers: {} } } }] });
  const segment = event('/live/ch/v_1.mp4').Records[0].cf.request;
  assert.equal(await handler({ Records: [{ cf: { config: { distributionDomainName: 'd.test' }, request: segment } }] }), segment);
  for (const uri of ['/live/ch/v.arch.soon.m3u8', '/live/ch/v.arch.m3u8a', '/live/ch/v.arch.json', '/live/ch/v.arch.100-199.txt', '/live/ch/v.arch.20261009T120000Z.m3u8']) {
    assert.equal((await handler(event(uri))).status, '404', uri);
  }
});

function tagLast(tag) {
  return Number(tag.uri.match(/\.(\d+)-(\d+)\.\d+-\d+\.m3u8a$/)[2]);
}
