// A stand-in for a user's wisp, for hostd's tests: `node fake-box.mjs --no-open --port N`. Answers
// /api/health, and /api/status from $HOME/status.json (the test writes it: live, clients, …), plus
// oom: the WISP_OUT_OF_MEMORY hostd started it with.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const file = path.join(process.env.HOME, 'status.json');
http
  .createServer((req, res) => {
    let s = {};
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/status' ? { live: 0, sides: 0, terms: 0, clients: 0, oom: process.env.WISP_OUT_OF_MEMORY || '', ...s } : { name: 'wisp' }));
  })
  .listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
