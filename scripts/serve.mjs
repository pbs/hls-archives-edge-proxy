#!/usr/bin/env node
// Serves the demos on http://localhost:8787/
//   node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 8787);
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.m3u8': 'application/vnd.apple.mpegurl' };

createServer(async (req, res) => {
  let path;
  try { path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)); } catch { res.writeHead(400); return res.end('bad request'); }
  if (path.endsWith('/')) path += 'index.html';
  const file = join(root, path);
  try {
    if ((await stat(file)).isDirectory()) { res.writeHead(302, { location: `${req.url}/` }); return res.end(); }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`));
