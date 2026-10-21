// Serves www/ for a look in a desktop browser; www/mock.js stands in for the native plugin.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = new URL('../www/', import.meta.url).pathname;
const port = Number(process.env.PORT) || 4780;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http
  .createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`preview: http://127.0.0.1:${port}/`));
