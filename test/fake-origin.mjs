// A synthetic origin. The timeline has 6.006 s segments with SCTE-35 style conditioning around ad
// breaks (a short segment going in, a long one coming out), one discontinuity with a new init
// segment, a PDT on every tenth segment and DATERANGE ad markers. It answers MediaPackage's
// start/end (whole seconds, every segment that overlaps) and Unified Origin's vbegin/vend and
// dvr_window_length.

export function makeTimeline({
  first = 100000, count = 3200, nominal = 6.006, endMs = Date.now(),
  breakEvery = 450, breakAt = 37, discAt = 1700,
} = {}) {
  const segs = [];
  for (let i = 0; i < count; i++) {
    const msn = first + i;
    const phase = i % breakEvery;
    const pre = [];
    let dur = nominal;
    if (phase === breakAt) { dur = 1.969; pre.push('#EXT-X-ELE_TITLE:'); }
    else if (phase === breakAt + 1) {
      dur = 4.037;
      pre.push('#EXT-OATCLS-SCTE35:/DAlAAAA', '#EXT-X-CUE-OUT:64.998',
        `#EXT-X-DATERANGE:ID="ad-${msn}",CLASS="ad",START-DATE="2026-01-01T00:00:00.000Z",DURATION=64.998`);
    } else if (phase > breakAt + 1 && phase <= breakAt + 11) {
      if (phase === breakAt + 11) dur = 6.907;
      pre.push(`#EXT-X-CUE-OUT-CONT:ElapsedTime=${(phase - breakAt - 1) * 6.006},Duration=64.998`);
    } else if (phase === breakAt + 12) pre.push('#EXT-X-CUE-IN');
    segs.push({ msn, dur, pre, disc: i === discAt, map: i >= discAt ? 'init2.mp4' : 'init1.mp4' });
  }
  let t = endMs - segs.reduce((acc, s) => acc + s.dur, 0) * 1000;
  for (const s of segs) { s.startMs = t; t += s.dur * 1000; }
  return segs;
}

export function fakeMediaPackage(timeline, { multivariant = 'index', renditions = ['v', 'a'], windowSegments = 50, dsnBase = 5, dsnTag = true, pdtEvery = 10, maxRangeSeconds = Infinity, slowAboveSeconds = Infinity } = {}) {
  const calls = [];
  const headers = (cacheControl) => ({ 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': cacheControl });

  async function fetchImpl(url, init) {
    calls.push(url);
    const u = new URL(url);
    const name = u.pathname.split('/').pop().replace(/\.m3u8$/, '');
    const start = u.searchParams.get('start'), end = u.searchParams.get('end');
    if (name === multivariant) {
      const q = start ? `?start=${start}` : '';
      const text = ['#EXTM3U', '#EXT-X-VERSION:6',
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="a.m3u8${q}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"', `v.m3u8${q}`, ''].join('\n');
      return new Response(text, { headers: headers('max-age=2') });
    }
    if (!renditions.includes(name)) return new Response('not found', { status: 404 });

    const iso = (v) => (v ? Date.parse(v) / 1000 : null);
    const window = u.searchParams.get('dvr_window_length');
    const from = start ?? iso(u.searchParams.get('vbegin')), to = end ?? iso(u.searchParams.get('vend'));
    if (from != null && to != null && to - from > maxRangeSeconds) return new Response('range too long', { status: 500 });
    // A slow range gives up when the caller's signal aborts, as a real fetch does.
    if (from != null && to != null && to - from > slowAboveSeconds) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); }, { once: true });
      });
    }

    let segs = timeline;
    if (from != null) segs = segs.filter((s) => s.startMs + s.dur * 1000 > Math.floor(Number(from)) * 1000);
    if (to != null) segs = segs.filter((s) => s.startMs <= Math.floor(Number(to)) * 1000);
    if (window != null) segs = segs.filter((s) => s.startMs + s.dur * 1000 > timeline.at(-1).startMs + timeline.at(-1).dur * 1000 - Number(window) * 1000);
    if (from == null && to == null && window == null) segs = segs.slice(-windowSegments);
    if (!segs.length) return new Response('outside startover window', { status: 404 });

    const firstDsn = dsnBase + timeline.filter((s) => s.disc && s.msn <= segs[0].msn).length;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:8'];
    if (to != null) lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
    else if (from != null) lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${segs[0].msn}`);
    if (dsnTag) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${firstDsn}`);
    segs.forEach((s, i) => {
      if (i > 0 && s.disc) lines.push('#EXT-X-DISCONTINUITY');
      if (i === 0 || s.disc || s.msn % pdtEvery === 0) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.startMs).toISOString()}`);
      if (i === 0 || s.disc) lines.push(`#EXT-X-MAP:URI="${s.map}"`);
      lines.push(...s.pre, `#EXTINF:${s.dur.toFixed(3)},`, `${name}_${s.msn}.mp4?m=1`);
    });
    if (to != null) lines.push('#EXT-X-ENDLIST');
    return new Response(lines.join('\n') + '\n', { headers: headers(to != null ? 'max-age=21600' : 'max-age=2') });
  }

  return { fetchImpl, calls };
}
