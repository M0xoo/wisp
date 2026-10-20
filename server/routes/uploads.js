// Attachments: POST streams the raw body to disk; GET serves it (from a machine for <id>@<machine>).

import fs from 'node:fs';
import { pipeFrom } from '../http/respond.js';
import { splitId } from '../machines.js';

export function register(r, app) {
  const { uploads, machines } = app;

  r.route('POST', '/uploads', async (c) => c.send(201, await uploads.receive(c.req, { name: c.query.get('name'), type: c.query.get('type') })));
  r.route('GET', '/uploads/:id', async (c) => {
    const at = splitId(c.params.id);
    if (at) return pipeFrom(c.res, await machines.stream(at.machine, 'GET', `/uploads/${at.id}`));
    const u = uploads.get(c.params.id);
    if (!u || !fs.existsSync(u.path)) return c.send(404, { error: 'not found' });
    c.res.writeHead(200, { 'content-type': u.mime, 'content-length': fs.statSync(u.path).size });
    fs.createReadStream(u.path).pipe(c.res);
  });
  // A moved task's bundle, once the other place has it (services/move.js).
  r.route('DELETE', '/uploads/:id', (c) => c.send(200, { ok: uploads.remove(c.params.id) }), { doc: false });
}
