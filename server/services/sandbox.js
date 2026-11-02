// /sandbox <task>: the task runs in a box of its own on your wisp Grid (grid/sandboxes.js) instead
// of on this computer or in your cloud computer. The box is a fresh one: the same image as a cloud
// computer, its own home, network and limits, so whatever the agent installs, runs or breaks there
// stays there. It goes when the task is deleted.
//
//   1. the grid makes the sandbox and hands back its address and its own token
//   2. it's added here as a machine (kind 'grid', `sandbox`, `task`), and woken
//   3. the project goes along as it is here: its commits and what isn't committed yet, as one git
//      bundle (git.js packWork, like moving a task), unpacked there into ~/code/<name> (seed())
//   4. the task launches there like on any machine (launcher.launchAny), in that folder
//
// Sign-ins: a sandbox starts with nothing signed in. You sign in once for all your sandboxes
// (Settings → Cloud → Sandboxes): `claude setup-token` runs here on a terminal of its own (pty.js),
// its link and code show on the page, and the long-lived token it prints goes straight to the grid,
// sealed for you there, never kept here. Each sandbox then starts with it (CLAUDE_CODE_OAUTH_TOKEN).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gridJson } from '../grid-client.js';
import { git, packWork, repoRoot } from '../git.js';
import { PARENT_SESSION_ENV, ptyCommand } from '../pty.js';
import { clean } from '../agent-login.js';
import { bad, expand } from '../util.js';
import { normalizeConnector } from '../connectors.js';
import { onPath } from '../proc.js';
import { sandboxAsk } from '../../web/js/slash-text.js';
import { gridTargets } from './publish.js';

const WAKE_MS = 3 * 60_000;
const PENDING_MS = 30 * 60_000; // a sandbox made for a launch that never finished (wisp quit mid-way)
const SWEEP_MS = 10 * 60_000;
const JOB_KEEP_MS = 24 * 3600_000; // a filed crew job's sandbox, to look at, before it goes
const JOB_KEEP = 2; // and at most this many of a member's filed ones at once
const SETUP_MS = 8 * 60_000; // .wisp/sandbox.sh, inside the seed request's 10 minutes
const LOGIN_MS = 15 * 60_000;
const MAX_OUT = 16_000;
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,400}/;
const PASTE = /paste\s*code\s*here/i;
const BRANCH = /^[\w./-]{1,120}$/;

export function createSandbox(app, { env = process.env } = {}) {
  const { store, machines, uploads } = app;
  let flow = null; // the sandboxes' Claude sign-in in progress
  let known = null; // what the grid said last: { logins, count }

  const targets = () => gridTargets(app, env);
  const target = () => {
    const t = targets()[0];
    if (!t) throw bad('Sign in to a wisp Grid first (Settings → Cloud): a sandbox is a box on your grid.', 409);
    return t;
  };
  const ask = async (t, method, p, body, opts = {}) => {
    let r;
    try {
      r = await gridJson(`${t.grid}${p}`, { method, body, headers: { authorization: t.auth }, timeout: 60_000, ...opts });
    } catch (err) {
      throw bad(`Couldn’t reach ${t.host}: ${err.message}`, 502);
    }
    if (r.status === 404 && method !== 'DELETE') throw bad(`${t.host} doesn’t make sandboxes yet (its wisp Grid is older).`, 409);
    if (r.status >= 400) throw bad(r.body.error || `${t.host} said ${r.status}.`, r.status === 401 ? 409 : r.status >= 500 ? 502 : r.status);
    return r.body;
  };

  const flowView = (f) => (f ? { state: f.state, url: f.url, needsInput: f.needsInput, checking: f.after != null && !f.needsInput && f.state === 'waiting', retry: f.after != null && f.needsInput, error: f.error || '' } : { state: 'idle' });
  async function view() {
    const t = targets()[0];
    if (!t) return { grid: null, logins: null, login: flowView(flow), sandboxes: 0 };
    try {
      const info = await ask(t, 'GET', '/api/sandboxes');
      known = { logins: info.logins || {}, env: info.env || [], count: (info.sandboxes || []).length, enabled: info.enabled !== false, list: (info.sandboxes || []).map(item) };
    } catch (err) {
      return { grid: { host: t.host, handle: t.handle }, logins: known?.logins || null, login: flowView(flow), sandboxes: known?.count || 0, list: known?.list || [], error: err.message };
    }
    return { grid: { host: t.host, handle: t.handle }, enabled: known.enabled, logins: known.logins, env: known.env, login: flowView(flow), sandboxes: known.count, list: known.list };
  }

  // Env vars every sandbox starts with (an API key, a database URL): sealed on the grid, like the
  // Claude token. Names come back, never values.
  async function setEnv(key, value) {
    const out = await ask(target(), 'PUT', '/api/sandboxes/env', { key, value });
    if (known) known.env = out.env;
    return { env: out.env };
  }
  async function dropEnv(key) {
    const out = await ask(target(), 'DELETE', `/api/sandboxes/env/${encodeURIComponent(key)}`);
    if (known) known.env = out.env;
    return { env: out.env };
  }

  // One of the grid's sandboxes, with what it's for here: a task, a lead's delegate, a crew member
  // or their job, or nothing (made from another device, or left behind): only those can be deleted
  // from the list; the rest go with their owner.
  function item(row) {
    const m = machines.list.find((x) => x.sandbox === row.id);
    const o = m?.owner || {};
    const crew = o.crew && (store.config.crew || []).find((c) => c.id === o.crew);
    const owner = o.task || o.job ? { kind: o.job ? 'job' : 'task', id: o.task || o.job, crew: crew?.name || '' } : o.lead ? { kind: 'delegate', id: o.lead } : crew ? { kind: 'crew', id: crew.id, name: crew.name } : o.pending ? { kind: 'starting' } : null;
    const st = m ? machines.view().find((x) => x.id === m.id)?.state || 'off' : 'off';
    return { id: row.id, name: row.name, createdAt: row.createdAt, owner, state: st, here: !!m };
  }

  // Delete from the list: a sandbox nothing here owns (from another device, or left behind).
  async function remove(id) {
    const m = machines.list.find((x) => x.sandbox === id);
    if (m?.owner && !m.dropping) throw bad('It goes with its task (or member): delete that instead.', 409);
    if (m) await drop(m);
    else await ask(target(), 'DELETE', `/api/sandboxes/${id}`);
    known = null;
    return view();
  }
  const changed = () => app.broadcast('sandbox', { login: flowView(flow), ...(known && { logins: known.logins }) });

  // --- signing in for sandboxes -------------------------------------------------------------

  function finish(f, state, error = '') {
    if (f.state !== 'running' && f.state !== 'waiting') return;
    clearTimeout(f.timer);
    Object.assign(f, { state, error });
    if (f.child.exitCode === null) f.child.kill('SIGKILL');
    changed();
  }

  // The token, on its way to the grid: not kept here, not in what the page sees.
  async function keep(f, token) {
    if (f.saving) return;
    f.saving = true;
    try {
      const out = await ask(f.target, 'PUT', '/api/sandboxes/logins/claude', { token });
      known = { ...(known || { count: 0, enabled: true }), logins: out.logins };
      finish(f, 'done');
      app.telemetry?.track?.('sandbox', { step: 'signed_in' });
    } catch (err) {
      finish(f, 'failed', err.message);
    }
  }

  function startLogin() {
    if (flow && (flow.state === 'running' || flow.state === 'waiting')) return flowView(flow);
    const t = target();
    const bin = env.WISP_CLAUDE_BIN || 'claude';
    const [cmd, args] = ptyCommand([bin, 'setup-token'], { cols: 1000, rows: 50 });
    const childEnv = { ...process.env, BROWSER: 'false' };
    for (const k of PARENT_SESSION_ENV) delete childEnv[k];
    // fd 3: pty.js's helper reads resizes there; it needs to be open.
    const child = spawn(cmd, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const f = { state: 'running', out: '', after: null, url: '', needsInput: false, child, target: t, startedAt: Date.now() };
    flow = f;
    child.stdin.on('error', () => {});
    const take = (d) => {
      f.out = (f.out + d).slice(-MAX_OUT);
      // After a paste, only what claude says since can ask for a code again (a wrong one).
      if (f.after != null) f.after = (f.after + d).slice(-MAX_OUT);
      const text = clean(f.out);
      const token = TOKEN.exec(text)?.[0];
      if (token) return void keep(f, token);
      const was = `${f.url}|${f.needsInput}`;
      f.url ||= /https?:\/\/[^\s"'<>]+/.exec(text)?.[0] || '';
      f.needsInput = PASTE.test(f.after != null ? clean(f.after) : text);
      if (f.url && f.state === 'running') f.state = 'waiting';
      if (`${f.url}|${f.needsInput}` !== was) changed();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => finish(f, 'failed', `Couldn’t run ${bin}: ${err.message}`));
    child.on('close', (code) => {
      if (f.saving) return;
      const last = clean(f.out).split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
      finish(f, 'failed', code === 127 || /not found|ENOENT/i.test(last || '') ? 'Claude Code isn’t installed here: install it, then sign in again.' : last || `claude setup-token exited (${code}).`);
    });
    f.timer = setTimeout(() => finish(f, 'failed', 'Sign-in timed out. Start again.'), LOGIN_MS);
    f.timer.unref?.();
    changed();
    return flowView(f);
  }

  function input(text) {
    const f = flow;
    if (!f || (f.state !== 'running' && f.state !== 'waiting')) throw bad('No sign-in is waiting for a code.', 409);
    const v = String(text || '').trim();
    if (!v || v.length > 4000 || /[\r\n]/.test(v)) throw bad('Paste the code the sign-in page showed.', 400);
    f.child.stdin.write(`${v}\r`);
    f.after = '';
    f.needsInput = false;
    changed();
    return flowView(f);
  }

  function cancel() {
    if (flow) finish(flow, 'cancelled');
    return flowView(flow);
  }

  async function logout(agent = 'claude') {
    const out = await ask(target(), 'DELETE', `/api/sandboxes/logins/${agent}`);
    known = { ...(known || { count: 0, enabled: true }), logins: out.logins };
    changed();
    return out;
  }

  // --- a task in a sandbox --------------------------------------------------------------------

  async function waitOnline(mid) {
    machines.connect(mid).catch(() => {});
    const until = Date.now() + WAKE_MS;
    while (Date.now() < until) {
      if (machines.isOnline(mid)) return;
      const c = machines.view().find((x) => x.id === mid);
      if (c?.state === 'error') throw bad(`The sandbox didn’t start: ${c.error || 'no answer'}`, 502);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw bad('The sandbox didn’t start in time. Try again in a minute.', 504);
  }

  // The project as it is here (commits and uncommitted changes), unpacked in the sandbox.
  async function carry(mid, dir) {
    const root = await repoRoot(dir);
    if (!root) return null;
    const u = uploads.reserve('work.bundle');
    let up = null;
    try {
      const pk = await packWork(root, null, u.file);
      if (!pk) return null; // a repo with no commit yet
      up = u.add();
      const there = await machines.upload(mid, up);
      const cfg = async (k) => (await git(root, ['config', k], { timeout: 5000 }).catch(() => '')).trim();
      const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }).catch(() => '')).trim();
      const origin = (await git(root, ['remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => '')).trim();
      const out = await machines.json(mid, 'POST', '/sandbox/seed', { upload: there.id, name: path.basename(root), ref: pk.ref, branch: branch === 'HEAD' ? '' : branch, origin, author: { name: await cfg('user.name'), email: await cfg('user.email') } }, { timeout: 10 * 60_000 });
      // How its .wisp/sandbox.sh went, for the task's prompt (a failure is the agent's to see).
      const mm = machines.list.find((x) => x.id === mid);
      if (mm) mm.setup = out.setup || null;
      const sub = path.relative(root, expand(dir));
      return sub && !sub.startsWith('..') ? path.posix.join(out.cwd, ...sub.split(path.sep)) : out.cwd;
    } finally {
      if (up) uploads.remove(up.id);
      else fs.rmSync(u.file, { force: true });
    }
  }

  // body: a launch (launcher.launchAny) whose prompt starts with /sandbox. Resolves its summaries.
  // Only Claude signs in for sandboxes so far: Auto runs Claude there, another harness can't.
  const harnessOk = (agent) => {
    if (agent && agent !== 'claude' && agent !== 'auto') throw bad('Only Claude Code signs in to sandboxes so far: pick Claude Code or Auto to run it in a sandbox.', 400);
  };

  // A new sandbox on the grid, as a machine here. owner: what it's for (see addSandbox); until its
  // owner is set for good, { pending } lets the sweep clean up after a wisp that quit half-way.
  async function make(name, owner = { pending: Date.now() }) {
    const t = target();
    const info = await ask(t, 'GET', '/api/sandboxes');
    if (info.enabled === false) throw bad(`${t.host} doesn’t make sandboxes.`, 409);
    if (!info.logins?.claude) throw Object.assign(bad('Sign in to Claude for your sandboxes first: a sandbox starts with nothing signed in.', 409), { sandboxLogin: true });
    const title = String(name || 'Sandbox').split('\n')[0].replace(/\s+/g, ' ').slice(0, 60);
    const sb = await ask(t, 'POST', '/api/sandboxes', { name: title });
    const m = machines.addSandbox({ url: sb.url, grid: t.grid, handle: t.handle, name: `Sandbox · ${title}`.slice(0, 40), token: sb.token, sandbox: sb.id, owner });
    app.broadcast('config', {});
    return m;
  }

  async function launch(body, origin = null) {
    const prompt = sandboxAsk(body.prompt);
    if (!prompt) throw bad('Say what to do after /sandbox, like “/sandbox try the new build script”.');
    harnessOk(body.agent || store.config.defaults.agent || 'auto');
    // The launch's placeholder card says where it's at (the page's key for it).
    const key = typeof body.progress === 'string' ? body.progress.slice(0, 40) : '';
    const step = (live) => key && app.broadcast('sandbox-step', { key, live });
    step(`Making a sandbox on ${target().host}`);
    const m = await make(prompt);
    try {
      // One task, one sandbox: compare runs (each a task) would share it and go with the first.
      const one = { ...body, prompt, agent: 'claude', compare: undefined, groupId: undefined, also: undefined, machine: m.id, worktree: false, progress: undefined };
      let cwd = null;
      for (let n = 0; ; n++) {
        step('Starting the sandbox');
        await waitOnline(m.id);
        try {
          if (cwd === null && !body.scratch && body.cwd) {
            step('Copying your project');
            cwd = (await carry(m.id, expand(body.cwd))) || '';
          }
          step('Starting the agent');
          const failed = m.setup && !m.setup.ok ? `\n\n(This sandbox ran the project's .wisp/sandbox.sh and it failed${m.setup.code != null ? ` with exit ${m.setup.code}` : ''}. Its last lines, full log in ~/.sandbox/setup.log:\n${m.setup.tail}\n)` : '';
          const out = await app.launcher.launchAny({ ...one, prompt: prompt + failed, ...(cwd ? { cwd, scratch: undefined } : { scratch: true, cwd: undefined }) }, origin);
          m.owner = { task: out[0].id };
          store.saveConfig();
          app.telemetry?.track?.('sandbox', { step: 'launched', project: !!cwd });
          return out;
        } catch (err) {
          // It went to sleep in between (idle): wake it and go again, a couple of times.
          if (err.status !== 503 || n >= 2) throw err;
        }
      }
    } catch (err) {
      await drop(m);
      throw err;
    }
  }

  // Gone from the grid, then from here. The grid unreachable: kept (hidden) as dropping, and the
  // sweep tries again, so its box and home don't stay behind counting against the limit.
  async function drop(m) {
    const t = targets().find((x) => x.grid === m.grid && x.handle === m.handle);
    try {
      if (t) await ask(t, 'DELETE', `/api/sandboxes/${m.sandbox}`);
    } catch (err) {
      console.warn(`wisp: sandbox ${m.sandbox}: ${err.message} (trying again later)`);
      m.dropping = true;
      machines.disconnect(m.id);
      store.saveConfig();
      return false;
    }
    if (machines.list.includes(m)) machines.remove(m.id);
    app.broadcast('config', {});
    return true;
  }

  // Sandboxes whose drop failed, and ones a launch made but never finished with.
  async function sweep() {
    for (const m of machines.list.filter((x) => x.sandbox)) {
      const leadGoneHere = m.owner?.lead && !String(m.owner.lead).includes('@') && !store.get(m.owner.lead);
      const filedLongAgo = m.owner?.job && m.owner.doneAt && Date.now() - m.owner.doneAt > JOB_KEEP_MS;
      const crewGoneHere = m.owner?.crew && !m.owner.job && !m.owner.pending && !(store.config.crew || []).some((c) => c.id === m.owner.crew);
      if (m.dropping || leadGoneHere || crewGoneHere || filedLongAgo || (m.owner?.pending && Date.now() - m.owner.pending > PENDING_MS)) await drop(m);
    }
  }
  let sweeper = null;

  // A sandbox machine about to go (DELETE /machines/:id, a grid account signed out): from the grid
  // too. The caller removes the machine.
  async function removing(m) {
    if (!m?.sandbox) return;
    const t = targets().find((x) => x.grid === m.grid && x.handle === m.handle);
    if (t) await ask(t, 'DELETE', `/api/sandboxes/${m.sandbox}`).catch((err) => console.warn(`wisp: sandbox ${m.sandbox}: ${err.message}`));
  }

  // The sandbox a task (<id>@<machine>) runs in, if it's that task's own (a /sandbox task, or a crew
  // member's job in a sandbox per job).
  const ownedBy = (id) => machines.list.find((x) => x.sandbox && (x.owner?.task === id || x.owner?.job === id || x.task === id)) || null;
  const mine = (pred) => machines.list.filter((x) => x.sandbox && !x.dropping && x.owner && pred(x.owner));

  // --- delegates and crew members in sandboxes ------------------------------------------------

  // A delegate whose place is Sandbox (services/relay.js): one sandbox per delegate of a lead,
  // kept while the lead lives, so delegating to it again finds its installs and files there.
  async function forDelegate({ lead, child, title, name }) {
    const key = `${lead}:${child}`;
    let m = mine((o) => o.delegate === key)[0];
    m ||= await make(`${name || 'Delegate'} · ${title || ''}`.trim(), { delegate: key, lead });
    await waitOnline(m.id);
    return m;
  }

  // The lead's work in a delegate's sandbox: its repo set up once from the delegation's bundle
  // (a full one: a private repo can't be fetched there), so each delegation unpacks on top of it.
  async function seedDelegate(m, pack, dir) {
    m.seeded ||= {};
    if (m.seeded[dir]) return m.seeded[dir];
    const out = await machines.json(m.id, 'POST', '/sandbox/seed', { upload: pack.upload, ref: pack.ref, name: path.basename(dir), keep: true }, { timeout: 10 * 60_000 });
    m.seeded[dir] = out.cwd;
    store.saveConfig();
    return out.cwd;
  }

  // A crew member whose jobs run in a sandbox (crew.js): their own one ('own', kept and reused),
  // or a fresh one per job ('job', gone with the job). Resolves { machine, cwd } for the launch,
  // with their project there as it is here.
  const making = new Map(); // crew member id -> their own sandbox being made (two jobs at once share it)
  async function forCrew(member, { title } = {}) {
    harnessOk(member.agent);
    if (member.sandbox === 'own' && making.has(member.id)) await making.get(member.id).catch(() => {});
    let m = member.sandbox === 'own' ? mine((o) => o.crew === member.id && !o.job && !o.pending)[0] : null;
    const fresh = !m;
    if (!m) {
      const p = make(`${member.name} · ${member.sandbox === 'own' ? 'their sandbox' : title || 'a job'}`, member.sandbox === 'own' ? { crew: member.id } : { crew: member.id, pending: Date.now() });
      if (member.sandbox === 'own') making.set(member.id, p);
      try {
        m = await p;
      } finally {
        if (making.get(member.id) === p) making.delete(member.id);
      }
    }
    try {
      await waitOnline(m.id);
      let cwd = '';
      if (member.cwd) {
        m.seeded ||= {};
        cwd = m.seeded[member.cwd] || (await carry(m.id, member.cwd)) || '';
        if (cwd) m.seeded[member.cwd] = cwd;
        store.saveConfig();
      }
      return { machine: m.id, cwd };
    } catch (err) {
      if (fresh) await drop(m);
      throw err;
    }
  }
  // A crew job started in its sandbox: it owns it now.
  function crewJob(mid, jobId) {
    const m = machines.list.find((x) => x.id === mid && x.sandbox);
    if (!m || m.owner?.crew === undefined || !m.owner.pending) return;
    m.owner = { crew: m.owner.crew, job: jobId };
    store.saveConfig();
  }
  // A crew job in a sandbox per job was filed (crew.js remoteSeen): it goes once it's old, or once
  // the member has more than a couple of filed ones (a scheduled member would fill the limit).
  async function jobFiled(id) {
    const m = mine((o) => o.job === id)[0];
    if (!m) return;
    m.owner = { ...m.owner, doneAt: m.owner.doneAt || Date.now() };
    store.saveConfig();
    const done = mine((o) => o.crew === m.owner.crew && o.job && o.doneAt).sort((a, b) => b.owner.doneAt - a.owner.doneAt);
    for (const x of done.slice(JOB_KEEP)) await drop(x);
  }
  // A crew member's sandboxes (their own one and their jobs'), for their jobs list.
  const crewMachines = (id) => mine((o) => o.crew === id).map((x) => x.id);

  // A lead deleted: its delegates' sandboxes go. A crew member removed: theirs too.
  async function leadGone(id) {
    for (const m of mine((o) => o.lead === id)) await drop(m);
  }
  // Their own sandbox goes with them; a job's stays with that job (it's an ordinary task now).
  async function crewGone(id) {
    for (const m of mine((o) => o.crew === id && !o.job && !o.pending)) await drop(m);
  }
  // Whether this wisp can make sandboxes now (a grid signed in), for wisp_available and the page.
  const available = () => targets().length > 0;

  // A task was deleted: its sandbox goes with it, whatever the sandbox's own wisp said.
  async function taskGone(id) {
    const m = ownedBy(id);
    return m ? drop(m) : false;
  }

  // --- in a sandbox: its browser, and what it installed ---------------------------------------

  const desktopBin = () => env.WISP_DESKTOP_BIN || 'wisp-desktop';
  const browserMcp = () => env.WISP_BROWSER_MCP_BIN || 'wisp-browser-mcp';

  // On the sandbox's start: the Browser connector (every task's agent drives the Chromium you can
  // watch), and the apt packages an earlier start installed (boxes start from the image each time).
  function inside() {
    try {
      const list = (store.config.connectors ||= []);
      if (onPath(browserMcp(), env) && !list.some((c) => c.name === 'browser')) {
        list.push(normalizeConnector({ name: 'browser', command: browserMcp() }, list).connector);
        store.saveConfig();
      }
    } catch (err) {
      console.warn(`wisp: sandbox browser: ${err.message}`);
    }
    const pkgs = path.join(os.homedir(), '.sandbox', 'packages');
    if (fs.existsSync(pkgs) && fs.statSync(pkgs).size) {
      const log = fs.openSync(path.join(os.homedir(), '.sandbox', 'restore.log'), 'a');
      // /usr/bin's apt-get, not the image's wrapper: they're written down already.
      // All at once, else one by one: a package that's gone from the archive doesn't stop the rest.
      const f = JSON.stringify(pkgs);
      const script = `/usr/bin/apt-get update -qq && { xargs -a ${f} /usr/bin/apt-get install -y -qq || while read -r p; do /usr/bin/apt-get install -y -qq "$p" || echo "wisp: couldn't install $p again"; done < ${f}; }`;
      const p = spawn('sudo', ['-n', 'sh', '-c', script], { stdio: ['ignore', log, log], detached: true });
      p.on('error', () => {});
      p.unref();
      fs.closeSync(log);
    }
  }

  // POST /sandbox/desktop, in a sandbox: its screen, browser and live view up (wisp-desktop).
  // size: where it's watched ({ width, height } in CSS pixels): the screen and window fit it.
  const fit = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
  function desktop({ width, height } = {}) {
    if (env.WISP_SANDBOX !== '1') throw bad('Only a sandbox has a browser to show.', 403);
    const size = `${fit(width, 360, 1920, 1280)}x${fit(height, 400, 1200, 800)}`;
    return new Promise((resolve, reject) => {
      let err = '';
      const p = spawn(desktopBin(), [], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WISP_DESKTOP_SIZE: size } });
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => reject(bad(`This sandbox has no browser (${e.message}). Its image is older: the next one has it.`, 501)));
      p.on('close', (code) => (code === 0 ? resolve({ port: 6080, size }) : reject(bad(err.trim() || `wisp-desktop exited (${code}).`, 502))));
    });
  }

  // Here: the live view of a sandboxed task's browser, as a link signed in for this once (the
  // grid's preview of port 6080 in that sandbox, noVNC).
  async function browser(id, size = {}) {
    const m = ownedBy(String(id || ''));
    if (!m) throw bad('That task doesn’t run in a sandbox.', 404);
    await waitOnline(m.id);
    await machines.json(m.id, 'POST', '/sandbox/desktop', { width: size.width, height: size.height }, { timeout: 60_000 });
    const view = '/wisp.html'; // noVNC's client, without its toolbar (the image's grid/deploy/image/sandbox/wisp.html)
    let r;
    try {
      r = await gridJson(`${m.url}/_grid/preview?port=6080&path=${encodeURIComponent(view)}`, { method: 'POST', token: app.secrets.get('machines', m.id), body: {} });
    } catch (err) {
      throw bad(`Couldn’t reach the sandbox: ${err.message}`, 502);
    }
    if (r.status >= 400) throw bad(r.body.error || `The grid said ${r.status}.`, r.status >= 500 ? 502 : r.status);
    return { url: r.body.url };
  }

  // In the sandbox (any wisp, really): a bundle from the wisp that asked, as a repo in ~/code.
  // keep: leave the bundle as an upload (a delegate's: its moved launch unpacks the same one next).
  async function seed({ upload, name, ref, branch, origin, author, keep = false } = {}) {
    if (env.WISP_SANDBOX !== '1') throw bad('Only a sandbox sets up projects this way.', 403);
    const u = uploads.get(String(upload || ''));
    if (!u) throw bad('The project’s bundle didn’t arrive.', 400);
    if (!/^refs\/wisp\/[\w./-]{1,120}$/.test(String(ref || ''))) throw bad('ref: the bundle’s ref.', 400);
    const base = path.join(os.homedir(), 'code');
    fs.mkdirSync(base, { recursive: true });
    const slug = String(name || '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'project';
    let dir = path.join(base, slug);
    for (let k = 2; fs.existsSync(dir); k++) dir = path.join(base, `${slug}-${k}`);
    try {
      await git(base, ['init', '-q', dir]);
      await git(dir, ['fetch', '-q', '--no-tags', u.path, `+${ref}:refs/wisp/seed`], { timeout: 300_000 });
      await git(dir, ['checkout', '-q', '-b', BRANCH.test(branch || '') ? branch : 'main', 'refs/wisp/seed^']);
      await git(dir, ['read-tree', '-u', '--reset', 'refs/wisp/seed']);
      await git(dir, ['reset', '-q']);
      await git(dir, ['update-ref', '-d', 'refs/wisp/seed']);
      if (typeof origin === 'string' && origin && !/^-/.test(origin)) await git(dir, ['remote', 'add', 'origin', origin]);
      // Commits there carry your name, as they would here.
      if (author?.name) await git(dir, ['config', 'user.name', String(author.name).slice(0, 200)]);
      if (author?.email) await git(dir, ['config', 'user.email', String(author.email).slice(0, 200)]);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw bad(`Couldn’t set up the project in the sandbox: ${err.message}`, 500);
    } finally {
      if (!keep) uploads.remove(u.id);
    }
    return { cwd: dir, setup: await setupScript(dir) };
  }

  // The project's own .wisp/sandbox.sh, run once when a sandbox gets it (installs, a database, seed
  // data), with sudo there. What it apt-installs comes back on the sandbox's next start; a failure
  // is reported, and the task still starts. Its output: ~/.sandbox/setup.log.
  function setupScript(dir) {
    const file = path.join(dir, '.wisp', 'sandbox.sh');
    if (!fs.existsSync(file)) return Promise.resolve(null);
    const logFile = path.join(os.homedir(), '.sandbox', 'setup.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    return new Promise((resolve) => {
      let out = '';
      const p = spawn('sh', [file], { cwd: dir, env: { ...process.env, WISP_SANDBOX: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => p.kill('SIGKILL'), SETUP_MS);
      const take = (d) => {
        out = (out + d).slice(-64_000);
        fs.appendFileSync(logFile, d);
      };
      p.stdout.on('data', take);
      p.stderr.on('data', take);
      p.on('error', (err) => (clearTimeout(timer), resolve({ ok: false, tail: err.message })));
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, tail: out.split('\n').filter(Boolean).slice(-12).join('\n') });
      });
    });
  }

  return {
    view,
    startLogin,
    input,
    cancel,
    logout,
    launch,
    removing,
    ownedBy,
    taskGone,
    harnessOk,
    forDelegate,
    seedDelegate,
    forCrew,
    crewJob,
    crewMachines,
    jobFiled,
    leadGone,
    crewGone,
    available,
    remove,
    setEnv,
    dropEnv,
    seed,
    sweep,
    browser,
    desktop,
    start() {
      if (env.WISP_SANDBOX === '1') inside();
      setTimeout(() => sweep().catch(() => {}), 5_000).unref?.();
      sweeper = setInterval(() => sweep().catch(() => {}), SWEEP_MS);
      sweeper.unref?.();
    },
    stop() {
      clearInterval(sweeper);
      if (flow) finish(flow, 'cancelled');
    },
  };
}
