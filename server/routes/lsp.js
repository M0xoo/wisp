// The editor's language intelligence (server/lsp.js): where a name is defined, where it's used,
// what it is, what's wrong in a file. Answers { lsp: null } when no language server is installed,
// and the page keeps its text search.
//
//   POST /sessions/:id/lsp   { op: definition | references | hover | diagnostics | rename, path, text, line, col, newName }
//   POST /lsp/install        { lang } npm's servers (TypeScript, Pyright) into <home>/lsp

import fs from 'node:fs';
import { execFile } from '../proc.js';
import { ask, installArgs, SERVERS } from '../lsp.js';
import { bad } from '../util.js';
import { sourceFile } from './workspace.js';

const OPS = new Set(['definition', 'references', 'hover', 'diagnostics', 'rename', 'completion']);
let installing = null;

export function register(r, app) {
  const { store } = app;
  r.route('POST', '/sessions/:id/lsp', async (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    const body = await c.body();
    if (!OPS.has(body.op)) throw bad(`op is one of ${[...OPS].join(', ')}`);
    const file = sourceFile(s, body.path);
    if (!file) return c.send(404, { error: 'That file isn’t in this task’s folder.' });
    const root = s.worktree?.path && fs.existsSync(s.worktree.path) ? s.worktree.path : s.cwd;
    const text = typeof body.text === 'string' ? body.text : fs.readFileSync(file, 'utf8');
    if (body.op === 'rename') {
      // It writes files: not under the agent's feet, and only to a name
      if (s.state === 'running' || s.state === 'waiting') return c.send(409, { error: 'The agent is working on this task: wait for it, or stop it, then rename.' });
      if (!/^[A-Za-z_$][\w$]*$/.test(String(body.newName || ''))) throw bad('newName is a name: letters, digits, _ and $');
    }
    try {
      c.send(200, await ask(root, store.home, body.op, file, text, Number(body.line) || 1, Number(body.col) || 1, { newName: body.newName }));
    } catch (err) {
      c.send(502, { error: err.message });
    }
  });

  r.route('POST', '/lsp/install', async (c) => {
    const { lang } = await c.body();
    const how = installArgs(String(lang || ''), store.home);
    if (!how) throw bad(`wisp installs ${Object.keys(SERVERS).filter((k) => SERVERS[k].npm).join(' and ')} servers; install others yourself`);
    if (installing) return c.send(409, { error: 'Already installing a language server' });
    fs.mkdirSync(how.dir, { recursive: true });
    installing = new Promise((resolve) => execFile('npm', how.args, { timeout: 5 * 60_000 }, (err, _o, stderr) => resolve(err ? String(stderr || err.message).trim().split('\n').slice(-3).join(' ') : null)));
    const err = await installing;
    installing = null;
    if (err) return c.send(500, { error: `Couldn’t install: ${err}` });
    c.send(200, { ok: true });
  });
}
