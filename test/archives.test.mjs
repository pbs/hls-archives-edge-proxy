import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/config.mjs';
import { parseMediaPlaylist } from '../src/playlist.mjs';
import {
  newestPublished, liveStartMsn, presentationStart, parseRoute, tableName, archiveName,
  buildTable, archiveTags, rle, expandRle, rangeForTable, msnAtTime, sized,
} from '../src/archives.mjs';
import { makeTimeline, fakeMediaPackage } from './fake-origin.mjs';

const cfg = { ...defaults, archiveSegments: 100, marginSegments: 8, archiveCount: 12, presentationSegments: 1200 };
const N = cfg.archiveSegments, M = cfg.marginSegments;

test('the newest published archive is closed and the live playlist overlaps it', () => {
  for (let L = 5000; L < 5000 + 3 * N; L++) {
    const k = newestPublished(L, cfg);
    const b = (k + 1) * N - 1;
    assert.ok(b <= L - M, 'closed with margin');
    assert.ok(b + N > L - M, 'the next bucket is not yet publishable');
    assert.ok(liveStartMsn(L, cfg) <= b + 1, 'live playlist continues from the archive');
    assert.ok(liveStartMsn(L, cfg) >= k * N, 'live playlist never reaches back past the newest archive');
  }
});

test('names parse back to what they encode', () => {
  const bk = { a: 447418050, b: 447418199, s: 1791451499, e: 1791452098 };
  assert.deepEqual(parseRoute(`/live/x/${archiveName('index_1080p', bk)}`), { kind: 'archive', dir: '/live/x/', name: 'index_1080p', ...bk });
  assert.deepEqual(parseRoute(`/live/x/${tableName('index_1080p', 2982787, { archiveSegments: 150 })}`), { kind: 'table', dir: '/live/x/', name: 'index_1080p', a: 447418050, b: 447418199 });
  assert.deepEqual(parseRoute('/live/x/index.arch.m3u8'), { kind: 'playlist', dir: '/live/x/', name: 'index', infix: '' });
  assert.deepEqual(parseRoute('/live/x/index.arch.1h30m.m3u8'), { kind: 'playlist', dir: '/live/x/', name: 'index', infix: '1h30m', windowSeconds: 5400 });
  assert.equal(parseRoute('/live/x/index.arch.soon.m3u8'), null);
  assert.equal(parseRoute('/live/x/index.arch.20261009T120000Z.m3u8'), null);
  assert.deepEqual(parseRoute('/live/ch.isml/.arch.m3u8'), { kind: 'playlist', dir: '/live/ch.isml/', name: '', infix: '' }, 'Unified Origin multivariant has no name');
  assert.equal(parseRoute('/live/x/index.m3u8'), null);
  assert.equal(parseRoute('/live/x/seg_1.mp4'), null);
});

test('sized() turns seconds into segment counts from the typical segment duration', () => {
  const segs = Array.from({ length: 200 }, (_, i) => ({ dur: i % 50 === 0 ? 1.969 : 6.006 }));
  const s = sized({ ...defaults, presentationSeconds: 7200, maxPresentationSeconds: 86400 }, segs);
  assert.equal(s.archiveSegments, 100);
  assert.equal(s.presentationSegments, 1199);
  assert.equal(s.archiveCount, 145);
  assert.equal(sized({ ...defaults, archiveSegments: 150 }, segs).archiveSegments, 150, 'a pinned size stays');
});

test('msnAtTime walks run-length durations across buckets', () => {
  const t0 = Date.parse('2026-10-09T00:00:00Z');
  const table = { buckets: [
    { a: 100, b: 103, pdt: new Date(t0).toISOString(), dur: [[6, 2], [2, 1], [4, 1]] },            // 0-6, 6-12, 12-14, 14-18
    { a: 104, b: 107, pdt: new Date(t0 + 18000).toISOString(), dur: [[6, 4]] },                       // 18-42
  ] };
  assert.equal(msnAtTime(table, t0 - 5000), 100, 'before the table: first known');
  assert.equal(msnAtTime(table, t0), 100);
  assert.equal(msnAtTime(table, t0 + 11999), 101);
  assert.equal(msnAtTime(table, t0 + 12000), 102);
  assert.equal(msnAtTime(table, t0 + 13999), 102);
  assert.equal(msnAtTime(table, t0 + 17000), 103);
  assert.equal(msnAtTime(table, t0 + 18000), 104);
  assert.equal(msnAtTime(table, t0 + 41999), 107);
  assert.equal(msnAtTime(table, t0 + 42000), 108, 'after the table: one past the end');
});

test('run-length encoding', () => {
  const durs = [6.006, 6.006, 1.969, 4.037, 6.006];
  assert.deepEqual(rle(durs), [[6.006, 2], [1.969, 1], [4.037, 1], [6.006, 1]]);
  assert.deepEqual(expandRle(rle(durs)), durs);
});

// A whole table built from the synthetic stream, then tags for a sweep of live edges.
test('tables and tags: exact durations, contiguity, monotonic roll-off', async () => {
  const timeline = makeTimeline({ count: 2000, discAt: 900 });
  const mp = fakeMediaPackage(timeline);
  const all = parseMediaPlaylist(await (await mp.fetchImpl('https://mp.test/p/v.m3u8?start=0&end=9999999999')).text()).segments;
  const L = all.at(-1).msn;
  const k = newestPublished(L, cfg);
  const table = buildTable(all, k, cfg);

  assert.equal(table.buckets.at(-1).b, (k + 1) * N - 1);
  assert.equal(table.buckets.length, cfg.archiveCount + 1);
  for (const bk of table.buckets) {
    const segs = all.filter((s) => s.msn >= bk.a && s.msn <= bk.b);
    assert.deepEqual(expandRle(bk.dur), segs.map((s) => s.dur), 'durations are the real ones');
    assert.deepEqual(bk.dr.map(([off, line]) => [bk.a + off, line]), segs.flatMap((s) => s.pre.filter((l) => l.startsWith('#EXT-X-DATERANGE')).map((l) => [s.msn, l])), 'date ranges recorded with their segment');
    assert.equal(bk.dsn, segs[0].dsn);
    assert.equal(Date.parse(bk.pdt), Math.round(segs[0].pdtMs));
    assert.ok(bk.s * 1000 < segs[0].pdtMs && bk.e * 1000 > segs.at(-1).pdtMs, 'start/end straddle the bucket');
  }
  const { startSec, endSec } = rangeForTable(all.slice(-120), k, { ...cfg, maxRangeSeconds: 3600, liveTailQuantumSeconds: 600 });
  const oldestPdt = Date.parse(table.buckets[0].pdt);
  assert.ok(startSec * 1000 < oldestPdt && oldestPdt - startSec * 1000 < 2 * 3600e3, 'range plan reaches back just far enough');
  assert.equal(startSec % 3600, 0, 'start on a whole hour');
  assert.equal(endSec % 600, 0, 'end on the 10-minute grid');
  const lastOfK = all.find((s) => s.msn === (k + 1) * N - 1);
  assert.ok(endSec * 1000 >= lastOfK.pdtMs + lastOfK.dur * 1000, 'end covers the newest bucket');
  assert.ok(endSec * 1000 - (lastOfK.pdtMs + lastOfK.dur * 1000) < 600e3, 'and not much more');

  let prevFirst = 0, prevNewest = 0, newAtZero = false;
  for (let live = L - N; live < L + 2 * N; live++) {
    const tags = archiveTags(table, live, 'v', cfg);
    assert.equal(tags[0].first, presentationStart(live, cfg));
    for (let i = 1; i < tags.length; i++) assert.equal(tags[i].first, tags[i - 1].last + 1, 'contiguous');
    assert.ok(tags.at(-1).last <= live - M);
    assert.ok(tags[0].first >= prevFirst && tags.at(-1).last >= prevNewest, 'only ever moves forward');
    prevFirst = tags[0].first; prevNewest = tags.at(-1).last;
    const exact = all.filter((s) => s.msn >= tags[0].first && s.msn <= tags[0].last).reduce((acc, s) => acc + s.dur, 0);
    assert.ok(Math.abs(tags[0].duration - exact) < 1e-6, 'oldest DURATION is the exact remaining sum');
    // The handler always reads the table for the current live edge.
    if (newestPublished(live, cfg) !== k) continue;
    const archived = all.filter((s) => s.msn >= tags[0].first && s.msn < liveStartMsn(live, cfg)).reduce((acc, s) => acc + s.dur, 0);
    assert.ok(Math.abs(tags.reduce((acc, t) => acc + t.duration, 0) - archived) < 1e-6, 'DURATIONs stop at the live playlist');
    if (tags.at(-1).first === liveStartMsn(live, cfg)) {
      assert.equal(tags.at(-1).duration, 0, 'a new archive starts at 0 s');
      newAtZero = true;
    }
  }
  assert.ok(newAtZero, 'the sweep sees an archive published');
});
