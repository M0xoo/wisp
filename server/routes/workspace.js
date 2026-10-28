// The panel beside a task: the folder it was built in (its worktree), a shell there, and its PRs
// in full. On a machine or a cloud computer the proxy passes these through, so the shell runs
// where the task does (routes/proxy.js); only "open in a terminal app" is decided here.
//
//   GET    /sessions/:id/workspace   the folder, branch, what's uncommitted or unpushed, the shell
//   GET    /sessions/:id/shell       its output as server-sent events (as /term)
//   POST   /sessions/:id/shell       { cols, rows } start it (or { restart }), { data } type, resize
//   DELETE /sessions/:id/shell       end it
//   POST   /sessions/:id/open-shell  the folder in the terminal app from Settings, on this desktop
//   GET    /sessions/:id/prs         every PR of the task in full: each check, reviews, comments
//   GET    /sessions/:id/check-log   ?url= a failing GitHub Actions job's log, its last lines

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorktree, gh, worktreeStatus } from '../git.js';
import { ptySupported } from '../pty.js';
import { workdir } from '../runner.js';
import { defaultTerminal, inWisp, openInTerminal } from '../terminal.js';
import { bad } from '../util.js';

// The user's login shell, started as one so their PATH and prompt come with it.
export const shellArgv = (env = process.env) => [env.SHELL || '/bin/sh', '-l'];

const LOG_LINES = 80;
// `gh run view --log-failed` prints "job<TAB>step<TAB>2026-…Z text": just the text, its tail.
export function logTail(out, n = LOG_LINES) {
  const lines = String(out || '')
    .split('\n')
    .map((l) => l.split('\t').slice(2).join('\t') || l)
    .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[\d;]*m/g, ''))
    .filter((l, i, a) => l.trim() || (i && a[i - 1].trim()));
  return lines.slice(-n).join('\n').trim();
}

// Where the shell opens: the worktree, else the project folder. A merged task's worktree is gone
// with its branch: then the project folder, and the page says so (gone).
export function shellDir(s) {
  const dir = workdir(s);
  if (dir && fs.existsSync(dir)) return { dir, gone: false };
  return { dir: s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir(), gone: true };
}

export function register(r, app) {
  const { store } = app;
  const one = (fn) => (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    return fn(c, s);
  };
  // A terminal app can open only on a desktop someone sits at: not a cloud computer or a server,
  // and not for a page that reached this wisp through the grid's edge.
  const appHere = (c) => !app.proxy?.via(c.req) && (process.platform === 'win32' || !inWisp('auto'));
  const open = (s) => app.shells.get(s.id)?.code === null;

  r.route(
    'GET',
    '/sessions/:id/workspace',
    one(async (c, s) => {
      // An archived task's clean worktree comes back from its branch, as a follow-up would bring it.
      if (s.worktree && !fs.existsSync(s.worktree.path)) await ensureWorktree(s.worktree).catch(() => {});
      const { dir, gone } = shellDir(s);
      const wt = s.worktree;
      const st = wt && !gone ? await worktreeStatus(wt, { merged: s.pr?.state === 'MERGED' && s.pr.head }) : null;
      c.send(200, {
        dir,
        gone,
        worktree: wt ? { branch: wt.branch, base: wt.base, remote: wt.remote || null } : null,
        status: st && { dirty: st.dirty, ahead: st.ahead, unpushed: st.unpushed },
        host: os.hostname(),
        shell: { supported: ptySupported(), open: open(s), app: appHere(c), name: path.basename(shellArgv()[0]) },
      });
    }),
  );

  r.route('GET', '/sessions/:id/shell', one((c, s) => app.shells.attach(s.id, c.req, c.res)));
  r.route(
    'POST',
    '/sessions/:id/shell',
    one(async (c, s) => {
      const body = await c.body();
      if (typeof body.data === 'string') {
        if (!open(s)) return c.send(404, { error: 'The shell has ended.' });
        app.shells.input(s.id, body.data);
        if (body.cols && body.rows) app.shells.resize(s.id, body.cols, body.rows);
        return c.send(200, { ok: true });
      }
      if (open(s) && !body.restart) {
        if (body.cols && body.rows) app.shells.resize(s.id, body.cols, body.rows);
        return c.send(200, { ok: true, started: false });
      }
      if (!ptySupported()) throw bad('A shell inside wisp needs macOS or Linux on the computer the task runs on.');
      if (body.restart) app.shells.close(s.id);
      if (s.worktree && !fs.existsSync(s.worktree.path)) await ensureWorktree(s.worktree).catch(() => {});
      const { dir, gone } = shellDir(s);
      app.shells.open(s.id, { argv: shellArgv(), cwd: dir, cols: body.cols, rows: body.rows });
      app.telemetry?.track('shell', { agent: s.agent });
      c.send(200, { ok: true, started: true, dir, gone });
    }),
  );
  r.route('DELETE', '/sessions/:id/shell', one((c, s) => c.send(200, { ok: app.shells.close(s.id) })));

  r.route(
    'POST',
    '/sessions/:id/open-shell',
    one(async (c, s) => {
      const { dir } = shellDir(s);
      if (!appHere(c)) return c.send(409, { error: 'There’s no terminal app on the computer this task runs on: use the one in the panel.', dir });
      const d = store.config.defaults;
      const terminal = d.terminal === 'wisp' || !d.terminal ? 'auto' : d.terminal; // "In wisp" is the panel itself
      if (process.env.WISP_NO_OPEN !== '1') openInTerminal({ cwd: dir, argv: shellArgv(), terminal, custom: d.terminalCommand });
      c.send(200, { ok: true, dir });
    }),
  );

  r.route(
    'GET',
    '/sessions/:id/prs',
    one(async (c, s) => c.send(200, { prs: await app.ship.details(s) })),
  );

  r.route(
    'GET',
    '/sessions/:id/check-log',
    one(async (c, s) => {
      const m = String(c.query.get('url') || '').match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/\d+\/job\/(\d+)/);
      if (!m) return c.send(200, { log: '' }); // not an Actions job: the agent looks at the link
      const dir = [s.worktree?.path, s.cwd].find((d) => d && fs.existsSync(d)) || os.homedir();
      const out = await gh(dir, ['run', 'view', '--job', m[3], '--log-failed', '-R', `${m[1]}/${m[2]}`], { timeout: 60_000 }).catch(() => '');
      c.send(200, { log: logTail(out) });
    }),
  );
}
