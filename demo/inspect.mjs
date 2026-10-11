// The edge handler runs here behind the CloudFront stand-in the tests use. Its reads of the origin
// are real; every response the "player" gets is generated in the page.

import { createLoopback } from '../src/loopback.mjs';
import { fetchText } from '../src/upstream.mjs';
import { parseMediaPlaylist, median } from '../src/playlist.mjs';
import { resolveOrigin } from '../src/origins.mjs';
import { defaults } from '../src/config.mjs';

const ORIGIN_NAMES = { mediapackage: 'MediaPackage', unified: 'Unified Origin' };
// Reach back 6 hours rather than the default 24, for a quicker first table.
const REACH_SECONDS = 6 * 3600;

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isOurs = (url) => /\.arch\./.test(url);

const state = { gen: 0, direct: false, host: null, origin: null, cfg: null, pending: [], nodes: [], bigBytes: 0, bigSegs: 0 };

// One edge per host and origin setting, so its cache lasts while you click around. A URL that
// already has .arch. in it comes from a real edge, so the page reads it directly instead.
function edgeFor(url) {
  const origin = $('origin').value;
  if (state.host === url.host && state.origin === origin) return;
  const record = (r) => state.pending.push(r);
  if (state.direct) {
    state.cfg = { ...defaults, onRequest: record };
  } else {
    const loop = createLoopback({ origin, maxPresentationSeconds: REACH_SECONDS, onRequest: record });
    state.cfg = { ...defaults, fetchImpl: loop.fetch, onRequest: record };
  }
  state.host = url.host;
  state.origin = origin;
}

const originName = (url) => ORIGIN_NAMES[resolveOrigin(new URL(url).pathname, { origin: state.origin })];

// Requests run one at a time, so each one's tree holds only what the edge fetched for it. Load
// starts a new generation, and anything from before it is dropped.
let queue = Promise.resolve();
function playerGet(href) {
  const gen = state.gen;
  queue = queue.then(() => gen === state.gen && get(href, gen)).catch((err) => status(err.message, true));
}

async function get(href, gen) {
  const url = new URL(href);
  edgeFor(url);
  status(`GET ${url.pathname.split('/').pop()} …`);
  state.pending = [];
  try {
    await fetchText(url.href, state.cfg);
  } catch (err) {
    if (gen === state.gen && !state.pending.length) status(explain(err), true);
    if (!state.pending.length) return;
  }
  if (gen !== state.gen) return;
  const [root] = buildTree(state.pending);
  addRows(root);
  show(root);
  status(state.direct
    ? `From the edge at ${url.host}. What it fetched to answer happens there, where this page can't see it.`
    : `Origin: ${originName(url.href)}.`);
}

// Requests are reported as they finish, deepest first. A node adopts the deeper ones before it.
function buildTree(events) {
  const stack = [];
  for (const ev of events) {
    const node = { ...ev, depth: ev.depth ?? 0, children: [] };
    while (stack.length && stack.at(-1).depth > node.depth) node.children.unshift(stack.pop());
    stack.push(node);
  }
  return stack;
}

function laneOf(node) {
  if (node.depth === 0) return ['player', 'player → edge'];
  return isOurs(node.url) ? ['edge', 'edge → edge'] : ['origin', `edge → ${originName(node.url)}`];
}

// A player request is one row, with what the edge fetched to serve it folded underneath.
function addRows(node) {
  const [lane, label] = laneOf(node);
  const tr = document.createElement('tr');
  if (node.depth === 0) tr.classList.add('top');
  else { tr.classList.add('sub'); tr.hidden = true; }
  const fetches = descendants(node).length;
  const controls = node.depth === 0
    ? '<button type="button" class="icon refresh" title="Request it again, as a player refreshing would">↻</button>'
    : '<span class="arrow">↳</span>';
  const fetched = node.depth > 0 ? ''
    : fetches
      ? `<button type="button" class="icon toggle" title="Show what the edge fetched" aria-expanded="false"><span class="chev">▸</span><span class="count">${fetches}</span></button>`
      : `<button type="button" class="icon toggle" title="The edge fetched nothing${/^Hit/.test(node.cache) ? ': this came from the cache' : ''}" disabled><span class="chev">▸</span><span class="count">0</span></button>`;
  tr.innerHTML = `<td class="req" style="padding-left:${6 + node.depth * 18}px">${controls}<span class="lane ${lane}">${label}</span>${esc(shortPath(node.url))}</td>` +
    `<td class="${node.status < 400 ? 'ok' : 'bad'}">${node.status}</td><td>${esc((node.cache ?? '').split(' ')[0] || '—')}</td>` +
    `<td class="num">${fmtBytes(node.bytes)}</td><td class="num">${node.ms}</td><td class="fetched num">${fetched}</td>`;
  tr.onclick = () => show(node);
  tr.querySelector('.refresh')?.addEventListener('click', (ev) => { ev.stopPropagation(); playerGet(node.url); });
  tr.querySelector('.toggle:enabled')?.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(node); });
  node.tr = tr;
  $('net').tBodies[0].append(tr);
  state.nodes.push(node);
  // Long reads show what a segment costs in a playlist without archives.
  const m = node.url.match(/start=(\d+)&end=(\d+)/) ?? node.url.match(/vbegin=([^&]+)&vend=(\S+)/);
  const seconds = m && (/^\d+$/.test(m[1]) ? m[2] - m[1] : (Date.parse(m[2]) - Date.parse(m[1])) / 1000);
  if (seconds >= 3600) { state.bigBytes += node.bytes; state.bigSegs += (node.body.match(/#EXTINF/g) ?? []).length; }
  node.children.forEach(addRows);
}

const shortPath = (url) => { const u = new URL(url); return u.pathname.split('/').pop() + u.search; };
const descendants = (node) => node.children.flatMap((c) => [c, ...descendants(c)]);

function toggle(node) {
  node.expanded = !node.expanded;
  for (const d of descendants(node)) d.tr.hidden = !node.expanded;
  const button = node.tr.querySelector('.toggle');
  button.setAttribute('aria-expanded', String(node.expanded));
  button.querySelector('.chev').textContent = node.expanded ? '▾' : '▸';
}

function show(node) {
  for (const n of state.nodes) n.tr.classList.toggle('sel', n === node);
  const [, label] = laneOf(node);
  $('viewerTitle').innerHTML = `${esc(shortPath(node.url))} <span class="meta">${label} · ${node.status} · ${fmtBytes(node.bytes)} · ${node.ms} ms</span>`;
  $('summary').textContent = summarize(node);
  $('viewer').innerHTML = render(node.body ?? '', node.url);
  $('panes').hidden = false;
}

function summarize(node) {
  const body = node.body ?? '';
  const path = new URL(node.url).pathname;
  if (path.endsWith('.json')) {
    try { const t = JSON.parse(body); return `A table of ${t.buckets.length} archives of ${t.n} segments each. The edge reads it to write the EXT-X-ARCHIVE tags.`; } catch { return ''; }
  }
  if (!body.startsWith('#EXT')) return '';
  if (/^#EXT-X-STREAM-INF/m.test(body)) return 'The multivariant playlist, pointing at the edge-synthesized, archive-aware media playlists. Click one.';
  const pl = parseMediaPlaylist(body);
  const dur = pl.segments.reduce((s, x) => s + x.dur, 0);
  if (path.endsWith('.m3u8a')) {
    return `An archive: ${pl.segments.length} segments, ${(dur / 60).toFixed(1)} minutes. It never changes, so it can be cached for a day.`;
  }
  const tags = [...body.matchAll(/^#EXT-X-ARCHIVE:.*DURATION=([\d.]+)/gm)];
  const total = tags.reduce((s, m) => s + Number(m[1]), 0) + dur;
  let text = `${pl.segments.length} segments in the playlist and ${tags.length} archives behind them: ${(total / 3600).toFixed(1)} hours in all.`;
  if (state.bigSegs && tags.length) {
    const perSegment = state.bigBytes / state.bigSegs;
    text += ` As one playlist, that would be about ${fmtBytes(Math.round(perSegment * total / median(pl.segments.map((s) => s.dur))))} on every refresh, not ${fmtBytes(node.bytes)}.`;
  }
  return text;
}

// Generated URIs become links; segment URIs are dimmed; long runs of segments are elided.
function render(text, baseUrl) {
  const link = (uri) => {
    let url;
    try { url = new URL(uri, baseUrl); } catch { return esc(uri); }
    return /^https?:$/.test(url.protocol) ? `<a href="${esc(url.href)}">${esc(uri)}</a>` : esc(uri);
  };
  let lines = text.split('\n');
  if (text.startsWith('{')) { try { lines = JSON.stringify(JSON.parse(text), null, 1).split('\n'); } catch { /* as is */ } }
  const firstSeg = lines.findIndex((l) => l.startsWith('#EXTINF'));
  if (lines.length > 320) {
    const head = firstSeg > 0 ? firstSeg + 60 : 120;
    lines = [...lines.slice(0, head), `… ${lines.length - head - 24} more lines …`, ...lines.slice(-24)];
  }
  return lines.map((l) => {
    if (l.startsWith('… ')) return `<span class="ell">${esc(l)}</span>`;
    if (l.startsWith('#')) {
      return l.split(/(URI="[^"]*")/).map((part) => {
        const m = part.match(/^URI="([^"]*)"$/);
        return m && isOurs(m[1]) ? `URI="${link(m[1])}"` : esc(part);
      }).join('');
    }
    if (l && isOurs(l)) return link(l);
    return l ? `<span class="seg">${esc(l)}</span>` : '';
  }).join('\n');
}

$('viewer').addEventListener('click', (ev) => {
  const a = ev.target.closest('a');
  if (!a) return;
  ev.preventDefault();
  playerGet(a.href);
});

$('form').onsubmit = (ev) => {
  ev.preventDefault();
  let url;
  try { url = new URL($('url').value); } catch { status('That is not a URL.', true); return; }
  const direct = isOurs(url.pathname);
  // index.m3u8 → index.arch.2h.m3u8
  if (!direct) {
    url.pathname = url.pathname.replace(/\.m3u8$/, `.arch.${$('window').value}.m3u8`);
    url.search = '';
  }
  $('net').tBodies[0].innerHTML = '';
  Object.assign(state, { gen: state.gen + 1, direct, nodes: [], bigBytes: 0, bigSegs: 0, host: null });
  $('net').classList.toggle('direct', direct);
  history.replaceState(null, '', query() || location.pathname);
  linkPlayer();
  playerGet(url.href);
};

// The origin and the window are part of an .arch. URL.
function syncOptions() {
  let direct = false;
  try { direct = isOurs(new URL($('url').value).pathname); } catch { /* not a URL yet */ }
  $('origin').disabled = direct;
  $('window').disabled = direct;
}
$('url').addEventListener('input', syncOptions);
// Only a stream other than the default goes in the address, so a link to the demo stays plain.
const query = () => ($('url').value === $('url').defaultValue ? '' : `?src=${encodeURIComponent($('url').value)}`);
const linkPlayer = () => { $('player').href = `./${query()}`; };

function status(msg, error = false) { $('status').textContent = msg; $('status').classList.toggle('error', error); }
function explain(err) {
  if (err.name === 'TypeError') return 'The request failed. The stream has to allow cross-origin requests (CORS) for this page to read it.';
  return err.message;
}

const src = new URLSearchParams(location.search).get('src');
if (src) $('url').value = src;
syncOptions();
linkPlayer();
if (src) $('form').requestSubmit();
