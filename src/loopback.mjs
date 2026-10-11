// A small stand-in for CloudFront, used by the tests, the check script and the demos. *.arch.*
// requests go to the handler and everything else to the network, and responses are cached for
// their Cache-Control max-age, as the distribution would cache them.
//
// onRequest sees every request with a `depth`: 0 for the caller's own, 1 for what the handler
// fetched to serve it, 2 for what the table handler fetched in turn.

import { createHandler } from './handler.mjs';

// How long CloudFront keeps an origin response that names no lifetime (CachingOptimized's default TTL).
const DEFAULT_UPSTREAM_TTL = 86400;

export function createLoopback({ fetchImpl = globalThis.fetch, onRequest, ...overrides } = {}) {
  const cache = new Map();
  let depth = 0;
  const handler = createHandler({ ...overrides, fetchImpl: loopFetch, onRequest: onRequest && ((r) => onRequest({ ...r, depth })) });

  async function loopFetch(url, init) {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return toResponse(hit, 'Hit');
    const u = new URL(url);
    if (!/\.arch\./.test(u.pathname)) return upstream(url, init);

    depth++;
    let out;
    try {
      out = await handler({ Records: [{ cf: {
        config: { distributionDomainName: u.host },
        request: { uri: u.pathname, querystring: u.search.slice(1), method: 'GET', headers: {} },
      } }] });
    } finally {
      depth--;
    }
    const entry = toEntry(out);
    remember(url, entry, 0);
    return toResponse(entry, 'Miss');
  }

  async function upstream(url, init) {
    const res = await fetchImpl(url, init);
    const entry = { status: res.status, headers: {}, body: await res.text() };
    for (const h of ['content-type', 'cache-control']) if (res.headers.get(h)) entry.headers[h] = res.headers.get(h);
    if (res.ok) remember(url, entry, DEFAULT_UPSTREAM_TTL);
    return toResponse(entry, 'Miss');
  }

  function remember(url, entry, defaultTtl) {
    const maxAge = Number(/max-age=(\d+)/.exec(entry.headers['cache-control'] ?? '')?.[1] ?? defaultTtl);
    if (maxAge > 0) cache.set(url, { ...entry, expires: Date.now() + maxAge * 1000 });
  }

  return { fetch: loopFetch, handler, cache };
}

function toEntry(out) {
  // The handler passed the request through: there is no origin behind this stand-in.
  if (!out.status) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
  const headers = {};
  for (const [, [h]] of Object.entries(out.headers ?? {})) headers[h.key.toLowerCase()] = h.value;
  return { status: Number(out.status), headers, body: out.body };
}

function toResponse(entry, state) {
  return new Response(entry.body, { status: entry.status, headers: { ...entry.headers, 'x-cache': `${state} from loopback` } });
}
