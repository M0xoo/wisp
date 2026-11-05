// The panel beside a task: the folder it was built in (its worktree), a shell there, and its PRs
// in full. On a machine or a cloud computer the proxy passes these through, so the shell runs
// where the task does (routes/proxy.js); only "open in a terminal app" is decided here.
//
//   GET    /sessions/:id/workspace   the folder, branch, what's uncommitted or unpushed, the shell
//   GET    /sessions/:id/shell       its output as server-sent events (as /term)
//   POST   /sessions/:id/shell       { cols, rows } start it (or { restart }), { data } type, resize
//   DELETE /sessions/:id/shell       end it
//   POST   /sessions/:id/open-shell  the folder in the terminal app from Settings, on this desktop
//   GET    /sessions/:id/run         the app run from the task's folder (Preview): command, running, port, url, exitCode, tail
//   POST   /sessions/:id/run         { command?, restart? } run it (server/runs.js); DELETE stops it
//   GET    /sessions/:id/run/log     its output as server-sent events: hello, lines, exit
//   GET    /sessions/:id/changes     what the task changed since its branch left the base, with hunks
//   POST   /sessions/:id/changes/revert { path, hunk?, key? } one hunk of it, or the file, back to the base; { path, restore } undoes it
//   POST   /sessions/:id/changes/stage  { path, hunk?, key?, unstage? } a file, or one hunk of it, into the index (or out)
//   POST   /sessions/:id/changes/commit { message, all? } a commit of what's staged (all: everything first): its short sha
//   GET    /sessions/:id/source      ?path= a file of the task's folder to edit: its text and hash
//   PUT    /sessions/:id/source      { path, text, hash } save it, if it's still the file you opened
//   GET    /sessions/:id/files       every file of the task's folder git knows (and new ones), for Open file…
//   GET    /sessions/:id/grep        ?q= text in those files, or ?def= where a name is defined, for the editor
//   GET    /sessions/:id/prs         every PR of the task in full: each check, reviews, comments
//   GET    /sessions/:id/check-log   ?url= a failing GitHub Actions job's log, its last lines

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseRef, ensureWorktree, gh, git, taskChanges, worktreeStatus } from '../git.js';
import { hunkKey, hunksOf, revertHunk } from '../hunks.js';
import { maskChangesFile, maskOn, maskRow } from '../env-mask.js';
// The page may have shown a .env file's hunk masked: its key is the masked rows'.
const sameHunk = (rows, key) => hunkKey(rows) === key || hunkKey(rows.map(maskRow)) === key;
import { commitStaged, hunkable, stageFile, stageHunk, stageState } from '../stage.js';
import { ptySupported } from '../pty.js';
import { workdir } from '../runner.js';
import { defaultTerminal, inWisp, openInTerminal } from '../terminal.js';
import { bad } from '../util.js';
import { conductorEnv } from '../conductor.js';
import { repoOf } from '../project-trust.js';
import { runCommand } from '../worktree-setup.js';
import { notSide } from '../side.js';

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

const GREP_MAX = 60; // hits: past this the search wants more words
const FILES_MAX = 20_000; // a monorepo's list past this waits for search
const SOURCE_MAX = 1024 * 1024; // past this the editor is the wrong tool: open it in yours
const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// A file the editor may open: inside the folder the task's paths are relative to (its worktree, or
// the project folder without one), not under .git, and not a link out of it.
export function sourceFile(s, rel) {
  const root = s.worktree?.path && fs.existsSync(s.worktree.path) ? s.worktree.path : s.cwd;
  if (!root || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const file = path.resolve(root, rel);
  const inside = (p, dir) => p.startsWith(dir + path.sep);
  if (!inside(file, root) || path.relative(root, file).split(path.sep)[0] === '.git') return null;
  try {
    if (!inside(fs.realpathSync(file), fs.realpathSync(root))) return null;
  } catch {
    return null; // gone (deleted by the task): nothing to edit
  }
  return file;
}

// A path a revert may write or remove: sourceFile's rules for a file that may not be there (a
// deleted file coming back, an added one going): its nearest folder that is there must be inside.
export function targetFile(s, rel) {
  const root = s.worktree?.path && fs.existsSync(s.worktree.path) ? s.worktree.path : s.cwd;
  if (!root || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || path.relative(root, file).split(path.sep)[0] === '.git') return null;
  let dir = file;
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  try {
    const real = fs.realpathSync(root);
    const at = fs.realpathSync(dir);
    if (at !== real && !at.startsWith(real + path.sep)) return null;
  } catch {
    return null;
  }
  return file;
}

const BUSY = 'The agent is working on this task: wait for it, or stop it.';
const STALE = 'This part changed since you looked: Changes is up to date now.';
const hashAt = (file) => (fs.existsSync(file) ? hashOf(fs.readFileSync(file)) : null);

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
        worktree: wt ? { branch: wt.branch, base: wt.base, remote: wt.remote || null, foreign: wt.foreign || '' } : null,
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
        app.shells.input(s.id, body.data, body);
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

  // Run the app (the panel's Preview): in the worktree, else the project folder; never a
  // folder-less task's scratch folder. The command: the page's, else .wisp/worktree.json's run,
  // else the repo's Conductor run script, else a guess from package.json (source says which).
  const runDir = (s) => {
    const w = s.worktree?.cwd || s.worktree?.path;
    if (w && fs.existsSync(w)) return w;
    return s.cwd && fs.existsSync(s.cwd) && !store.isScratch?.(s.cwd) ? s.cwd : null;
  };
  // The checkout dir is in: where Conductor's file is and its workspace.
  const runTop = (s, dir) => (s.worktree?.path && fs.existsSync(s.worktree.path) ? s.worktree.path : repoOf(dir).top);
  const runConfig = (s) => {
    const dir = runDir(s);
    const top = dir && runTop(s, dir);
    const here = dir && runCommand(dir, top);
    if (here || !s.cwd || dir === s.cwd || !fs.existsSync(s.cwd)) return here || null;
    const from = repoOf(s.cwd).top;
    const cfg = runCommand(s.cwd, from);
    // Found in the project folder only (not committed): it still runs in the task's own folder.
    return cfg?.cwd && top ? { ...cfg, cwd: path.resolve(top, path.relative(from, cfg.cwd)) } : cfg;
  };
  const NO_FOLDER = 'This task has no folder to run an app from.';
  r.route(
    'GET',
    '/sessions/:id/run',
    one((c, s) => {
      const dir = runDir(s);
      const v = app.runs.view(s.id);
      c.send(200, { command: null, running: false, ready: false, port: null, url: null, proxyUrl: null, exitCode: null, tail: '', ...v, dir: v?.dir || dir, config: dir ? runConfig(s) : null, canRun: !!dir });
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/run',
    one(async (c, s) => {
      const body = await c.body();
      if (body.command !== undefined && (typeof body.command !== 'string' || body.command.length > 2000)) throw bad('command is the line to run, up to 2000 characters');
      if (s.worktree && !fs.existsSync(s.worktree.path)) await ensureWorktree(s.worktree).catch(() => {});
      const dir = runDir(s);
      if (!dir) return c.send(409, { error: NO_FOLDER });
      if (app.runs.running(s.id) && !body.restart) return c.send(200, app.runs.view(s.id));
      const cfg = runConfig(s);
      const command = (body.command || '').trim() || cfg?.command;
      if (!command) throw bad(`Nothing to run: ${cfg?.problem ? `${cfg.problem}. Fix it, or type` : 'type'} the command that starts the app (npm run dev, …), or add "run" to .wisp/worktree.json.`);
      const opts = { dir, command, port: cfg?.port || null };
      if (cfg?.source === 'conductor') {
        // A typed command too: it's still this repo's app, and may read them.
        const top = runTop(s, dir);
        const branch = s.worktree?.base || (await baseRef(top).catch(() => null))?.branch;
        const env = { root: s.worktree?.root || top, dir: top, branch };
        Object.assign(opts, { dir: cfg.cwd || dir, ports: 10, portKey: path.basename(top), envFor: (port) => conductorEnv({ ...env, port }) });
      }
      const v = await app.runs.start(s.id, opts);
      app.telemetry?.track('run_app', { agent: s.agent, source: body.command ? (body.command.trim() === cfg?.command ? cfg.source : 'typed') : cfg?.source });
      c.send(200, v);
    }),
  );
  r.route('DELETE', '/sessions/:id/run', one(async (c, s) => c.send(200, { ok: await app.runs.stop(s.id), ...app.runs.view(s.id) })));
  r.route('GET', '/sessions/:id/run/log', one((c, s) => app.runs.attach(s.id, c.req, c.res)));

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

  // A task without a worktree (or with it gone) gets { files: null }: the page shows the edits wisp
  // captured instead, since a diff of the project folder would hold the user's own work too.
  r.route(
    'GET',
    '/sessions/:id/changes',
    one(async (c, s) => {
      if (s.worktree && !fs.existsSync(s.worktree.path)) await ensureWorktree(s.worktree).catch(() => {});
      const out = s.worktree && !shellDir(s).gone ? await stageState(s.worktree.path, await taskChanges(s.worktree)) : null;
      // .env files' values masked, but for the ones whose Reveal is on (?reveal=<path>, repeated).
      const reveal = new Set(c.query.getAll('reveal'));
      if (out?.files && maskOn(store.config)) out.files = out.files.map((f) => maskChangesFile(f, reveal));
      c.send(200, out || { files: null });
    }),
  );

  // Changes' Revert (hunks.js): one hunk of a file back as the merge-base had it, checked against
  // the hunk the page showed (key) and the file's lines now; or the whole file (git checkout from
  // the merge-base, or removed when the task added it). restore is its Undo: the file's text from
  // before (null: it wasn't there), if it's still as the revert left it (hash).
  r.route(
    'POST',
    '/sessions/:id/changes/revert',
    one(async (c, s) => {
      notSide(s, 'revert files');
      const body = await c.body();
      if (typeof body.path !== 'string' || !body.path) throw bad('path is required');
      if (s.state === 'running' || s.state === 'waiting') return c.send(409, { error: BUSY });
      if (s.worktree && !fs.existsSync(s.worktree.path)) await ensureWorktree(s.worktree).catch(() => {});
      if (!s.worktree || shellDir(s).gone) return c.send(409, { error: 'Only a task with a worktree can revert here.' });
      const root = s.worktree.path;
      if ('restore' in body) {
        if (body.restore !== null && typeof body.restore !== 'string') throw bad('restore is the file’s text, or null');
        const file = targetFile(s, body.path);
        if (!file) return c.send(404, { error: 'That file isn’t in this task’s folder.' });
        if (body.hash !== undefined && hashAt(file) !== body.hash) return c.send(409, { error: 'The file changed since it was reverted: Undo would lose that.' });
        if (body.restore === null) fs.rmSync(file, { force: true });
        else (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, body.restore));
        return c.send(200, { ok: true, hash: hashAt(file) });
      }
      const ch = await taskChanges(s.worktree);
      const f = ch?.files.find((x) => x.path === body.path);
      if (!f) return c.send(409, { error: STALE });
      if (body.hunk != null) {
        if (!Number.isInteger(body.hunk) || body.hunk < 0) throw bad('hunk is the hunk’s index in the file');
        if (f.status === 'A' || f.status === 'D' || f.binary) throw bad('That file is new or deleted as a whole: revert the file.');
        const hs = hunksOf(f.rows);
        const h = hs[body.hunk];
        if (!h || (body.key && !sameHunk(h.rows, body.key))) return c.send(409, { error: STALE });
        if (f.more && body.hunk === hs.length - 1) throw bad('That part is longer than Changes shows: revert the file, or edit it.');
        const file = sourceFile(s, f.path);
        if (!file) return c.send(409, { error: STALE });
        const text = revertHunk(fs.readFileSync(file, 'utf8'), f.rows, body.hunk);
        if (text == null) return c.send(409, { error: STALE });
        fs.writeFileSync(file, text);
        return c.send(200, { ok: true, hash: hashAt(file) });
      }
      // The whole file. A rename goes back to its old name: the new one goes, the old one returns.
      const file = targetFile(s, f.path);
      const from = f.from ? targetFile(s, f.from) : null;
      if (!file || (f.from && !from)) return c.send(404, { error: 'That file isn’t in this task’s folder.' });
      const rel = (p) => path.relative(root, p).split(path.sep).join('/');
      // The working tree only, like a hunk's revert: nothing staged, so Undo puts it all back
      if (f.status === 'A' || f.status === 'R') fs.rmSync(file, { force: true });
      if (f.status !== 'A') await git(root, ['restore', `--source=${ch.at}`, '--worktree', '--', rel(from || file)]);
      c.send(200, { ok: true, hash: hashAt(file) });
    }),
  );

  // Changes' Stage / Unstage and Commit (stage.js), as VS Code's Source Control: not while the agent
  // works (its next edit would land in the middle), only in the task's own worktree, and only for a
  // file Changes lists, inside the folder. A hunk is checked against the one the page showed (key).
  const gitHere = async (s) => {
    if (s.state === 'running' || s.state === 'waiting') return { error: BUSY };
    if (s.worktree && !fs.existsSync(s.worktree.path)) await ensureWorktree(s.worktree).catch(() => {});
    if (!s.worktree || shellDir(s).gone) return { error: 'Only a task with a worktree can stage and commit here.' };
    return { root: s.worktree.path };
  };
  r.route(
    'POST',
    '/sessions/:id/changes/stage',
    one(async (c, s) => {
      notSide(s, 'stage files');
      const body = await c.body();
      if (typeof body.path !== 'string' || !body.path) throw bad('path is required');
      const { root, error } = await gitHere(s);
      if (error) return c.send(409, { error });
      const unstage = !!body.unstage;
      const ch = await taskChanges(s.worktree);
      const f = ch?.files.find((x) => x.path === body.path);
      if (!f) return c.send(409, { error: STALE });
      if (!targetFile(s, f.path) || (f.from && !targetFile(s, f.from))) return c.send(404, { error: 'That file isn’t in this task’s folder.' });
      const gone = unstage ? 'That isn’t staged any more: Changes is up to date now.' : 'There’s nothing left to stage there: Changes is up to date now.';
      try {
        if (body.hunk != null) {
          if (!Number.isInteger(body.hunk) || body.hunk < 0) throw bad('hunk is the hunk’s index in the file');
          if (!hunkable(f)) throw bad('That file is new, deleted or binary: stage the whole file.');
          const hs = hunksOf(f.rows);
          const h = hs[body.hunk];
          if (!h || (body.key && !sameHunk(h.rows, body.key))) return c.send(409, { error: STALE });
          if (f.more && body.hunk === hs.length - 1) throw bad('That part is longer than Changes shows: stage the file.');
          if (!(await stageHunk(root, f, body.hunk, { unstage }))) return c.send(409, { error: gone });
        } else if (!(await stageFile(root, [f.path, f.from], { unstage }))) return c.send(409, { error: gone });
      } catch (err) {
        if (err.status) throw err;
        return c.send(409, { error: `git refused: ${err.message}` });
      }
      c.send(200, { ok: true });
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/changes/commit',
    one(async (c, s) => {
      notSide(s, 'commit');
      const body = await c.body();
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) throw bad('Write a commit message first.');
      const { root, error } = await gitHere(s);
      if (error) return c.send(409, { error });
      let sha;
      try {
        sha = await commitStaged(root, message, { all: !!body.all });
      } catch (err) {
        return c.send(409, { error: `git couldn’t commit: ${err.message}` });
      }
      if (!sha) throw bad(body.all ? 'Nothing to commit: the folder is as its last commit.' : 'Nothing is staged: stage a file or a hunk first.');
      c.send(200, { ok: true, sha });
    }),
  );

  // The side panel's editor (changes.js): one file of the task's, as text. Not while the agent
  // works on it (its next edit would land on yours), and not over a newer copy than you opened.
  r.route(
    'GET',
    '/sessions/:id/source',
    one((c, s) => {
      const file = sourceFile(s, c.query.get('path'));
      if (!file || !fs.statSync(file).isFile()) return c.send(404, { error: 'That file isn’t in this task’s folder any more.' });
      const buf = fs.readFileSync(file);
      if (buf.length > SOURCE_MAX) return c.send(413, { error: 'Too big to edit here (over 1 MB): open it in your editor.' });
      if (buf.includes(0)) return c.send(415, { error: 'Not a text file: open it in your editor.' });
      c.send(200, { path: c.query.get('path'), text: buf.toString('utf8'), hash: hashOf(buf) });
    }),
  );
  r.route(
    'PUT',
    '/sessions/:id/source',
    one(async (c, s) => {
      notSide(s, 'edit files');
      const body = await c.body();
      if (typeof body.text !== 'string') throw bad('text is required');
      if (Buffer.byteLength(body.text) > SOURCE_MAX) return c.send(413, { error: 'Too big to save here (over 1 MB).' });
      if (s.state === 'running' || s.state === 'waiting') return c.send(409, { error: 'The agent is working on this task: wait for it, or stop it, then save.' });
      const file = sourceFile(s, body.path);
      if (!file) return c.send(404, { error: 'That file isn’t in this task’s folder any more.' });
      const now = fs.readFileSync(file);
      if (body.hash && hashOf(now) !== body.hash) return c.send(409, { error: 'The file changed since you opened it.', text: now.toString('utf8'), hash: hashOf(now) });
      fs.writeFileSync(file, body.text);
      c.send(200, { ok: true, hash: hashOf(Buffer.from(body.text)) });
    }),
  );

  // Open file… in the panel's editor: the folder's files as git lists them (tracked, and new ones
  // not ignored), at most FILES_MAX. Not a git folder: none, the page says so.
  r.route(
    'GET',
    '/sessions/:id/files',
    one(async (c, s) => {
      const root = s.worktree?.path && fs.existsSync(s.worktree.path) ? s.worktree.path : s.cwd;
      const out = root ? await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 15_000 }).catch(() => null) : null;
      const files = out == null ? [] : [...new Set(out.split('\0').filter(Boolean))].sort();
      c.send(200, { files: files.slice(0, FILES_MAX), more: Math.max(0, files.length - FILES_MAX), git: out != null });
    }),
  );

  // @ in New task's box: a project's files (on this computer), for a mention of one
  r.route('GET', '/files', async (c) => {
    const p = (store.config.projects || []).find((x) => x.id === c.query.get('project') && !x.machine);
    if (!p || !fs.existsSync(p.path)) return c.send(404, { error: 'No such project on this computer' });
    const out = await git(p.path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 15_000 }).catch(() => null);
    const files = out == null ? [] : [...new Set(out.split('\0').filter(Boolean))].sort();
    c.send(200, { files: files.slice(0, FILES_MAX), more: Math.max(0, files.length - FILES_MAX), git: out != null });
  });

  // The editor's search across files and Go to definition: git grep over the same files Open file…
  // lists. A definition is the name after a keyword that declares one, or assigned a function.
  r.route(
    'GET',
    '/sessions/:id/grep',
    one(async (c, s) => {
      const root = s.worktree?.path && fs.existsSync(s.worktree.path) ? s.worktree.path : s.cwd;
      const q = String(c.query.get('q') || '');
      const def = String(c.query.get('def') || '');
      if (def && !/^[A-Za-z_$][\w$]{0,80}$/.test(def)) throw bad('def is a name: letters, digits, _ and $');
      if (!def && q.trim().length < 2) return c.send(200, { hits: [] });
      const n = def.replace(/\$/g, '\\$');
      const args = def
        ? ['grep', '-n', '-I', '--untracked', '-E', '-e', `(^|[^[:alnum:]_$.])(function\\*?|class|def|func|fn|struct|enum|trait|interface|type|module|const|let|var)[[:space:]]+${n}([^[:alnum:]_$]|$)`, '-e', `(^|[^[:alnum:]_$.])${n}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\()`]
        : ['grep', '-n', '-I', '--untracked', '-i', '-F', '-e', q.slice(0, 200)];
      const out = root ? await git(root, [...args, '--', '.'], { timeout: 15_000 }).catch((err) => (err.code === 1 ? '' : null)) : null;
      if (out == null) return c.send(200, { hits: [], git: false });
      const hits = out
        .split('\n')
        .filter(Boolean)
        .slice(0, GREP_MAX)
        .map((l) => {
          const m = l.match(/^(.*?):(\d+):(.*)$/);
          return m && { path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 240) };
        })
        .filter(Boolean);
      c.send(200, { hits, git: true });
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
