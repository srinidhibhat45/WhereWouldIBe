/**
 * serve.mjs — a static file server for local development.
 *
 * The app is plain ES modules and fetch()ed JSON, so it needs to be served
 * over http rather than opened as a file://. No dependencies; just run it.
 *
 *   node tools/serve.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);

  // Keep requests inside the project directory.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || stat.isDirectory()) {
      if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
      else { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  });
}).listen(PORT, () => {
  console.log(`Where Would I Be…?  →  http://localhost:${PORT}`);
});
