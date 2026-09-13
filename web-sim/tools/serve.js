// A static file server with no dependencies, so the harness survives a cold clone.
//
//   node tools/serve.js <root> <port>
//
// Two of these run side by side while measuring: 8793 over ../../lilguy-fork/public (the reference,
// which drives the real WASM renderer) and 8794 over this folder.
//
// The .wasm content type is not cosmetic: animation_renderer.js reaches the wasm through
// WebAssembly.instantiateStreaming, which REJECTS any response that is not application/wasm. Serve
// it as octet-stream and the reference silently renders nothing, which reads exactly like a broken
// harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const [rootArg, portArg] = process.argv.slice(2);
if (!rootArg || !portArg) {
  console.error('usage: node tools/serve.js <root> <port>');
  process.exit(2);
}
const root = path.resolve(rootArg);
const port = Number(portArg);

const server = http.createServer((req, res) => {
  // Strip the query string: the harness appends ?state=... and the file itself is unaware of it.
  const rel = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, rel);
  // Never escape the root.
  if (!path.resolve(file).startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
