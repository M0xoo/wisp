// /api/sessions/<id>@<machine>/…: passed through to that machine's wisp, ids rewritten.
// Registered before the session routes, so a qualified id never reaches them.

import os from 'node:os';
import { btwQuestion } from '../btw.js';
import { pipeFrom } from '../http/respond.js';
import { splitId, qualify } from '../machines.js';
import { defaultTerminal, inWisp, openInTerminal, shq } from '../terminal.js';
import { MAX_WAIT_S } from './sessions.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function register(r, app) {
  const { store, machines, telemetry } = app;
  const remote = { when: (p) => !!splitId(p.id), doc: false };

  async function proxy(c) {
    const at = splitId(c.params.id);
    const { action } = c.params;
    const m = c.req.method;
    const mid = at.machine;
    const sub = `/sessions/${at.id}${action ? `/${action}` : ''}${c.url.search}`;
    if ((action === 'file' && m === 'GET') || (action === 'presentation' && c.query.get('format') === 'markdown')) return pipeFrom(c.res, await machines.stream(mid, 'GET', sub));
    // The terminal of a take over in the page, streamed from over there.
    if (action === 'term' && m === 'GET') {
      const r = await machines.stream(mid, 'GET', sub);
      c.res.on('close', () => r.destroy()); // the page went away: so does the stream over there
      return pipeFrom(c.res, r);
    }
    // Take over: in the page, a terminal over there (a cloud computer has no other); else a
    // terminal app here, signed in over there, resuming the agent in its folder.
    if (action === 'takeover') {
      const d = store.config.defaults;
      const body = m === 'POST' ? await c.body() : {};
      if (m === 'POST' && (body.inline === true || inWisp(d.terminal || defaultTerminal()) || machines.get(mid)?.kind === 'grid')) {
        const out = await machines.json(mid, 'POST', `/sessions/${at.id}/takeover`, { inline: true, cols: body.cols, rows: body.rows });
        // An older wisp over there opened its own terminal app instead.
        if (!out.inline) return c.send(409, { error: `Update wisp on ${machines.get(mid)?.name || mid} to take over in the page.` });
        telemetry.track('takeover', { terminal: 'wisp', machine: true });
        return c.send(200, { command: out.command, inline: true });
      }
      const { command } = await machines.json(mid, 'GET', `/sessions/${at.id}/takeover`);
      if (machines.get(mid)?.kind === 'grid') return c.send(200, { command }); // no SSH in: the command as it runs there
      const argv = machines.terminalArgv(mid, command);
      if (m === 'POST') {
        const s = await machines.json(mid, 'GET', `/sessions/${at.id}`);
        if (s.state === 'running' || s.state === 'waiting') await machines.json(mid, 'POST', `/sessions/${at.id}/stop`, {});
        openInTerminal({ cwd: os.homedir(), argv, terminal: d.terminal || defaultTerminal(), custom: d.terminalCommand });
        telemetry.track('takeover', { agent: s.agent, terminal: d.terminal || defaultTerminal(), machine: true });
      }
      return c.send(200, { command: argv.map(shq).join(' ') });
    }
    const body = m === 'GET' ? undefined : await c.body();
    // A follow-up that moves the task here or to another machine (services/move.js).
    if (action === 'reply' && typeof body?.machine === 'string') {
      if (body.machine !== mid && btwQuestion(body.text) === null) return c.send(200, await app.mover.move(c.params.id, body.machine, { ...body, text: String(body.text || '').trim() }));
      delete body.machine;
    }
    if (action === 'reply' && body?.attachments?.length) body.attachments = await app.launcher.pushUploads(mid, body.attachments);
    const out = await machines.json(mid, m, sub, body, action === 'wait' ? { timeout: (MAX_WAIT_S + 30) * 1000 } : undefined);
    if (!action && m === 'GET') return c.send(200, machines.session(mid, out));
    if ((!action && m === 'PATCH') || action === 'wait') return c.send(200, machines.summary(mid, out));
    if (out && typeof out === 'object' && out.sessionId) out.sessionId = qualify(out.sessionId, mid);
    c.send(200, out);
  }

  r.route(METHODS, '/sessions/:id', proxy, remote);
  r.route(METHODS, '/sessions/:id/:action', proxy, remote);
}
