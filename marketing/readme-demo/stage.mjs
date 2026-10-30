// The set for the README demo: an isolated wisp (qa/lib.mjs) whose `claude` is director.mjs, a demo
// repo, and a crew seeded from the templates. Exports start() for record.mjs; run alone to keep it up.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, startWisp } from '../../qa/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function bin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdemo-bin-'));
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nimport(${JSON.stringify('file://' + path.join(HERE, 'director.mjs'))});\n`);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  return dir;
}

function repo() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rdemo-')), 'acme-api');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/checkout.js'), 'export async function total(cart) {\n  const rates = await fetchRates();\n  return cart.sum * rates.tax;\n}\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
  fs.mkdirSync(path.join(dir, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/auth/login.js'), "import { verify } from './passwords.js';\n\nexport async function login(req, res) {\n  const { email, password } = req.body;\n  if (!(await verify(email, password))) return res.status(401).end();\n  res.json({ ok: true });\n}\n");
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=dev@acme.dev', '-c', 'user.name=dev', 'add', '.');
  git('-c', 'user.email=dev@acme.dev', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return dir;
}

export const MEMBERS = [
  { name: 'Scout', role: 'CI watcher', avatar: 'ghost.sky.visor.flat.antenna', color: 'sky', cron: '*/30 * * * *', brief: 'Watch CI on main. When a run fails, fix it on a branch. When green, stay quiet.' },
  { name: 'Quill', role: 'PR reviewer', avatar: 'blob.violet.wide.flat.headphones', color: 'violet', cron: '0 * * * *', brief: 'Review new pull requests. Never push or merge.' },
  { name: 'Tinker', role: 'Dependency keeper', avatar: 'star.lime.dots.grin.beanie', color: 'lime', cron: '0 9 * * 1', brief: 'Keep dependencies current.' },
  { name: 'Echo', role: 'Release notes', avatar: 'drop.rose.happy.cat.halo', color: 'rose', cron: '0 9 * * 1-5', brief: 'Draft release notes from what merged.' },
];

export async function start({ port = 4496, seed = MEMBERS } = {}) {
  const cwd = repo();
  const w = await startWisp({ port, extraEnv: { PATH: `${bin()}:${process.env.PATH}`, DIRECTOR_SCALE: process.env.DIRECTOR_SCALE || '1' } });
  await api(w.url, '/api/config', { defaults: { agent: 'claude', theme: process.env.THEME || 'dark' } }, 'PATCH').catch(() => {});
  for (const x of (await api(w.url, '/api/sessions')).json || []) await api(w.url, `/api/sessions/${x.id}`, { archived: true }, 'PATCH');
  await api(w.url, '/api/projects', { path: cwd });
  const crew = {};
  for (const m of seed) crew[m.name] = (await api(w.url, '/api/crew', { ...m, cwd, agent: 'claude' })).json;
  return { ...w, cwd, crew };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await start();
  console.log(w.url, w.cwd, Object.values(w.crew).map((m) => m?.id || JSON.stringify(m)));
  process.on('SIGINT', () => (w.stop(), process.exit(0)));
  setInterval(() => {}, 1 << 30);
}
