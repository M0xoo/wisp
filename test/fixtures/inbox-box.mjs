// A stand-in for a user's wisp, for grid/inbox.js's tests: `node inbox-box.mjs --no-open --port N`.
// $HOME/box.json says how it behaves ({ bootMs, status, failIds, answerMs, live, answer }), and every message the
// grid delivers lands in $HOME/inbound.jsonl with its HTTP headers (http).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const home = process.env.HOME;
const conf = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'box.json'), 'utf8'));
  } catch {
    return {};
  }
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/channels/inbound') {
    let t = '';
    for await (const c of req) t += c;
    const c = conf();
    fs.appendFileSync(path.join(home, 'inbound.jsonl'), `${JSON.stringify({ ...JSON.parse(t), http: req.headers })}\n`);
    if (c.answerMs) await new Promise((r) => setTimeout(r, c.answerMs));
    // failIds: update ids it answers 500 to, whatever status says.
    const id = c.failIds && JSON.parse(Buffer.from(JSON.parse(t).body, 'base64').toString('utf8')).update_id;
    res.writeHead(c.failIds?.includes(id) ? 500 : c.status || 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(c.answer ?? {}));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/api/status' ? { live: conf().live || 0, sides: 0, terms: 0, clients: 0 } : { name: 'wisp' }));
});
setTimeout(() => server.listen(port, '127.0.0.1'), conf().bootMs || 0);
process.on('SIGTERM', () => process.exit(0));
