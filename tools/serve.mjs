// serve.mjs: a static server for local checks. It mounts the films repo at /films/, the way GitHub Pages serves
// stevenkauwe.github.io and stevenkauwe.github.io/films/ from one origin, and honours Range (seeking needs 206s).
// Usage: node tools/serve.mjs <port> <siteDir> <filmsDir>
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';

const [port, siteDir, filmsDir] = process.argv.slice(2);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json', '.md': 'text/markdown',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  let path = decodeURIComponent(urlPath);
  let root = resolve(siteDir);
  if (path === '/films' || path.startsWith('/films/')) { root = resolve(filmsDir); path = path.slice('/films'.length) || '/'; }
  let file = join(root, normalize(path)), st;
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    st = statSync(file);
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) { res.writeHead(301, { Location: urlPath + '/' }).end(); return; }
      file = join(file, 'index.html'); st = statSync(file);
    }
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
  const head = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0, end = st.size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], st.size - 1); } else start = Math.max(0, st.size - +m[2]);
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
    code = 206; head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  head['Content-Length'] = end - start + 1;
  res.writeHead(code, head);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file, { start, end }).pipe(res);
}).listen(+port, '127.0.0.1', () => console.log(`serving ${siteDir} at / and ${filmsDir} at /films/ on http://127.0.0.1:${port}/`));
