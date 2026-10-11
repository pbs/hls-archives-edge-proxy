import Hls, { LoadStats } from '../vendor/hls.js/hls.min.mjs';
import { createLoopback } from '../src/loopback.mjs';

// The edge here reaches back 6 hours rather than the default 24, for a quicker first table.
const REACH_SECONDS = 6 * 3600;

const $ = (id) => document.getElementById(id);
const video = $('video');

let hls = null;
let edge = null;

// hls.js loads every playlist through this, so .arch.* requests reach the edge running in the page.
class EdgeLoader {
  constructor() {
    this.stats = new LoadStats();
    this.context = null;
  }

  load(context, config, callbacks) {
    const { stats } = this;
    this.context = context;
    stats.loading.start = performance.now();
    edge.fetch(context.url).then(async (res) => {
      const data = await res.text();
      if (stats.aborted) return;
      stats.loading.first = stats.loading.end = performance.now();
      stats.loaded = stats.total = data.length;
      if (res.ok) callbacks.onSuccess({ url: context.url, data, code: res.status }, stats, context, null);
      else callbacks.onError({ code: res.status, text: data.trim() }, context, null, stats);
    }, (err) => {
      if (!stats.aborted) callbacks.onError({ code: 0, text: err.message }, context, null, stats);
    });
  }

  abort() {
    this.stats.aborted = true;
  }

  destroy() {
    this.abort();
  }
}

// This assumes that a URL with .arch. in it already comes from an edge with archives, so hls.js loads it as it is.
const isArchiveUrl = (src) => {
  try { return new URL(src).pathname.includes('.arch.'); } catch { return false; }
};

function play(src, span) {
  if (!Hls.isSupported()) {
    status('This browser has no Media Source Extensions, which hls.js needs.', true);
    return;
  }
  const url = new URL(src);
  const direct = isArchiveUrl(src);
  if (!direct) {
    url.pathname = url.pathname.replace(/\.m3u8$/, `.arch.${span}.m3u8`);
    url.search = '';
  }

  hls?.destroy();
  edge = direct ? null : createLoopback({ maxPresentationSeconds: REACH_SECONDS });
  hls = new Hls(direct ? {} : { pLoader: EdgeLoader });
  hls.on(Hls.Events.ERROR, (event, data) => {
    if (data.fatal) status(`Can't play this one: ${data.details}. The stream needs CORS${direct ? '' : ' and a DVR window'}.`, true);
  });
  hls.on(Hls.Events.LEVEL_LOADED, (event, { stats }) => {
    if (!status.error) status(`Each live playlist refresh${direct ? ` from ${url.host}` : ''} is ${(stats.total / 1024).toFixed(0)} KB.`);
  });
  status(direct ? `Playing straight from ${url.host}.` : 'Building the first archive table, which takes a few seconds…');
  hls.loadSource(url.href);
  hls.attachMedia(video);
  // For poking at in the console: hls.latestLevelDetails.archives
  window.hls = hls;
}

// The archives and the live playlist in timeline order, where hls.js has them now. hls.js plays
// everything from the playlist's first segment on from the playlist, so archives end there.
function spans() {
  const details = hls?.latestLevelDetails;
  if (!details?.fragments.length) return [];
  const { fragmentStart } = details;
  const out = [];
  let start = Math.min(details.start, fragmentStart);
  (details.archives ?? []).forEach((archive, i) => {
    const end = Math.min(details.archiveEnd(archive), fragmentStart);
    const state = archive.details ? 'loaded' : archive.loader ? 'loading' : archive.error ? 'failed' : '';
    out.push({ start, end, state, title: `Archive ${i + 1} · ${clock(archive.startDate)}${state ? ` · ${state}` : ''}` });
    start = end;
  });
  out.push({ start: fragmentStart, end: details.edge, state: 'live', title: 'Live playlist' });
  return out;
}

// The bar is the window from its first second to the live edge, drawn to scale.
function render() {
  const all = spans();
  if (!all.length) return;
  const first = all[0].start;
  const length = all.at(-1).end - first;
  const percent = (time) => `${(Math.min(Math.max((time - first) / length, 0), 1) * 100).toFixed(3)}%`;

  const bar = $('bar');
  while (bar.children.length < all.length) bar.append(document.createElement('span'));
  while (bar.children.length > all.length) bar.lastChild.remove();
  all.forEach((s, i) => {
    const el = bar.children[i];
    el.className = s.state;
    el.title = s.title;
    el.style.left = percent(s.start);
    el.style.width = `calc(${percent(s.end)} - ${percent(s.start)})`;
  });
  $('playhead').style.left = percent(video.currentTime);
  $('count').textContent = `${all.length - 1} archives, ${all.filter((s) => s.state === 'loaded').length} loaded`;
}

$('bar').addEventListener('click', (event) => {
  const all = spans();
  if (!all.length) return;
  const rect = event.currentTarget.getBoundingClientRect();
  video.currentTime = all[0].start + ((event.clientX - rect.left) / rect.width) * (all.at(-1).end - all[0].start);
});

const clock = (date) => (date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

function status(text, error = false) {
  status.error = error;
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function start() {
  try {
    play($('url').value, $('window').value);
  } catch {
    status('That is not a URL.', true);
  }
}

// Only a stream other than the default goes in the address, so a link to the demo stays plain.
function query() {
  const url = $('url').value;
  return url === $('url').defaultValue ? '' : `?src=${encodeURIComponent(url)}`;
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  start();
  history.replaceState(null, '', query() || location.pathname);
});

// The window is part of an .arch. URL.
function sync() {
  $('window').disabled = isArchiveUrl($('url').value);
  $('inspect').href = `inspect.html${query()}`;
}
$('url').addEventListener('input', sync);

const params = new URLSearchParams(location.search);
if (params.get('src')) $('url').value = params.get('src');
history.replaceState(null, '', query() || location.pathname);
sync();
setInterval(render, 500);
start();
