// The set for the site's screenshots (docs/assets/shots/): an isolated wisp (qa/lib.mjs) whose
// `claude` and `codex` are director.mjs, two Claude Code accounts (Work, Personal), three projects,
// a crew, a machine (this computer behind test/fixtures/fake-ssh.mjs) and the tasks each shot needs.
// Exports start() for shoot.mjs; run alone to keep it up and look around.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, startWisp } from '../../qa/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `gshots-${p}-`));

function bin() {
  const dir = tmp('bin');
  const fakes = path.join(dir, 'fake');
  fs.mkdirSync(fakes);
  const launcher = (f) => `#!${process.execPath}\nimport(${JSON.stringify('file://' + f)});\n`;
  for (const n of ['claude', 'codex']) {
    fs.copyFileSync(path.join(ROOT, 'test/fixtures/fake-agent.mjs'), path.join(fakes, `${n}.mjs`));
    fs.writeFileSync(path.join(dir, n), launcher(path.join(HERE, 'director.mjs')));
  }
  fs.writeFileSync(path.join(dir, 'ssh'), launcher(path.join(ROOT, 'test/fixtures/fake-ssh.mjs')));
  for (const f of ['claude', 'codex', 'ssh']) fs.chmodSync(path.join(dir, f), 0o755);
  return { dir, fakes };
}

// The files the scripted work changes, committed, so each diff is a real change.
const FILES = {
  'api-server': {
    'src/auth/session.ts': 'export class SessionStore {\n  constructor({ ttlMs }) {\n    this.ttlMs = ttlMs;\n    this.map = new Map();\n  }\n  touch(id) {\n    this.map.set(id, Date.now() + this.ttlMs);\n  }\n  expired(id) {\n    return (this.map.get(id) ?? 0) < Date.now();\n  }\n}\n',
    'src/validate.ts': "import { z } from 'zod';\nexport const format = (e) => e.format();\n",
    'src/schemas/user.ts': 'email: z.string().email(),\n',
    'src/routes/invoices.ts': 'const rows = await db.invoices.all();\n',
  },
  'web-app': { 'src/auth/login.css': '.login { width: 412px; }\n', 'src/onboarding/Welcome.tsx': 'export const Welcome = () => null;\n' },
  mobile: { 'android/PermissionGate.kt': 'class PermissionGate\n' },
};

function repo(parent, name) {
  const dir = path.join(parent, name);
  for (const [f, body] of Object.entries(FILES[name])) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  const git = (...a) => execFileSync('git', ['-c', 'user.email=dev@acme.dev', '-c', 'user.name=dev', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  // An origin, so the machine can set the project up from it.
  execFileSync('git', ['clone', '-q', '--bare', dir, `${dir}.git`]);
  git('remote', 'add', 'origin', `${dir}.git`);
  return dir;
}

// What wisp's goal checks say after rounds 1 and 2 (the fake agent answers them).
const GOAL_CHECKS = [
  { why: 'Two auth tests still fail, and the login form is 412px wide on a phone', next: 'Fix the token race in session.test.ts, then the form width', progress: 35 },
  { why: 'The tests pass, but the login form is 412px wide on a phone', next: 'Let the form shrink below 420px in login.css', progress: 70 },
];

const MEMBERS = [
  { name: 'Scout', role: 'CI watcher', avatar: 'ghost.sky.visor.flat.antenna', color: 'sky', cron: '*/30 * * * *', brief: 'Watch CI on main. When a run fails, fix it on a branch.' },
  { name: 'Quill', role: 'PR reviewer', avatar: 'blob.violet.wide.flat.headphones', color: 'violet', cron: '0 * * * *', brief: 'Review new pull requests. Never push or merge.' },
  { name: 'Echo', role: 'Release notes', avatar: 'drop.rose.happy.cat.halo', color: 'rose', cron: '0 9 * * 1-5', brief: 'Draft release notes from what merged.' },
];

export async function start({ port = 4511, machinePort = 4521 } = {}) {
  const parent = tmp('repos');
  const repos = Object.fromEntries(Object.keys(FILES).map((n) => [n, repo(parent, n)]));
  const b = bin();
  const home = tmp('home');
  fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ claude: [{ id: 'default', label: 'Work' }, { id: 'pers', label: 'Personal', kind: 'personal' }] }));
  const w = await startWisp({
    port,
    extraEnv: { WISP_HOME: home, PATH: `${b.dir}:${process.env.PATH}`, FAKE_AGENTS: b.fakes, WISP_SSH: path.join(b.dir, 'ssh'), FAKE_SSH_HOME: tmp('there'), WISP_UPDATE_CHECK: '0', FAKE_DELAY: '300', FAKE_GOAL_SCRIPT: JSON.stringify(GOAL_CHECKS) },
  });
  await api(w.url, '/api/config', { defaults: { agent: 'claude', theme: 'system' } }, 'PATCH');
  for (const x of (await api(w.url, '/api/sessions')).json || []) await api(w.url, `/api/sessions/${x.id}`, { archived: true }, 'PATCH');
  for (const r of Object.values(repos)) await api(w.url, '/api/projects', { path: r });
  const crew = {};
  for (const m of MEMBERS) crew[m.name] = (await api(w.url, '/api/crew', { ...m, cwd: repos['api-server'], agent: 'claude' })).json;
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'bin/wisp.js'))}`;
  const studio = (await api(w.url, '/api/machines', { name: 'studio', target: 'me@studio', port: machinePort, command })).json;
  for (let i = 0; i < 120 && (await api(w.url, '/api/machines')).json.some((m) => m.state !== 'online'); i++) await new Promise((r) => setTimeout(r, 500));

  const task = async (prompt, cwd, body = {}) => (await api(w.url, '/api/sessions', { prompt, cwd: repos[cwd], agent: 'claude', ...body })).json;
  const ids = {};
  // Oldest first: the list sorts newest on top.
  ids.camera = (await task('Crash on Android 15 when the camera permission is denied', 'mobile')).id;
  ids.invoices = (await task('Paginate the /invoices endpoint', 'api-server', { agent: 'codex' })).id;
  ids.compare = (await task('Migrate validation to zod 4', 'api-server', { compare: [{ agent: 'codex' }] })).id;
  ids.spell = (await api(w.url, '/api/sessions', { prompt: 'A floating Board button that opens a task board: how many tasks are working, need me and are done', kind: 'spell', agent: 'claude' })).json.id;
  ids.flaky = (await task('Fix the flaky session-expiry test', 'api-server')).id;
  ids.node = (await task('Upgrade to Node 22 and fix whatever breaks', 'web-app', { agent: 'codex', machine: studio.id })).id;
  ids.onboarding = (await task('Onboarding: skip the empty state when a team exists', 'web-app')).id;
  ids.goal = (await task('Fix login on phones and the flaky auth tests', 'web-app', { goal: { text: 'every auth test passes and the login form fits a 390px phone', max: 10 } })).id;
  ids.stripe = (await task('Migrate billing webhooks to the new Stripe API', 'api-server')).id;
  // Last: once Work is at its limit, tasks started by hand go to Personal.
  ids.limit = (await task('Bump the auth SDK and fix the deprecations', 'api-server', { account: 'default' })).id;

  // wisp's own welcome task isn't part of any shot.
  for (const x of (await api(w.url, '/api/sessions')).json || []) if (x.agent === 'wisp') await api(w.url, `/api/sessions/${x.id}`, { archived: true }, 'PATCH');
  const stop = w.stop;
  w.stop = () => {
    stop();
    try {
      execFileSync('sh', ['-c', `lsof -ti tcp:${machinePort} -sTCP:LISTEN | xargs kill`]);
    } catch {}
  };
  return { ...w, repos, crew, ids, studio };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await start();
  console.log(w.url, JSON.stringify(w.ids));
  process.on('SIGINT', () => (w.stop(), process.exit(0)));
  setInterval(() => {}, 1 << 30);
}
