// A stand-in for a user's wisp, for hostd's and boxd's tests: `node fake-box.ts --no-open --port N`.
// Answers /api/health, and /api/status from $HOME/status.json (the test writes it: live, clients, …),
// plus oom: the WISP_OUT_OF_MEMORY hostd started it with. Like a real wisp it keeps its data in
// WISP_HOME (or $HOME/.wisp), and POST /api/sessions makes a task (201). FAKE_BOX_BOOT_MS: how long
// it takes before it listens (bench/wake.ts).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const home = process.env['HOME'] ?? '.';
const file = path.join(home, 'status.json');
fs.mkdirSync(process.env['WISP_HOME'] || path.join(home, '.wisp'), { recursive: true });

const status = (): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const server = http.createServer((req, res) => {
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/api/status') return send(200, { live: 0, sides: 0, terms: 0, clients: 0, oom: process.env['WISP_OUT_OF_MEMORY'] || '', ...status() });
  if (req.method === 'POST' && req.url === '/api/sessions') {
    req.resume();
    return req.on('end', () => send(201, { id: `s${Date.now()}` }));
  }
  // What it was started with, for the test that the operator's shell doesn't leak into a box.
  if (req.url === '/_test/env') return send(200, process.env);
  send(200, { name: 'wisp' });
});
setTimeout(() => server.listen(port, '127.0.0.1', () => console.log(`wisp (stand-in) on ${port}`)), Number(process.env['FAKE_BOX_BOOT_MS'] || 0));
process.on('SIGTERM', () => process.exit(0));
