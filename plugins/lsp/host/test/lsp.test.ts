// The editor's language intelligence (v1 test/lsp.test.js): talking LSP to a language server (a fake
// one here), and the route's checks in front of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Session } from '@wisp-plugin/runtime-api';
import { askFor, installer } from '../src/index.ts';
import { ask, findServer, installArgs, langOf, Pool } from '../src/lsp.ts';
import { sourceFile } from '../src/source.ts';
import { pipes, realLater } from './fixtures/pipes.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));
const tmp = (p: string): string => fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `wisp-${p}`)));
const proc = pipes();
const pool = (env: Record<string, string | undefined> = { WISP_LSP_TS: `${process.execPath} ${FAKE}` }) => new Pool({ proc, later: realLater, where: { env, platform: process.platform, home: null }, pid: process.pid });
const pools: Pool[] = [];
const fresh = (env?: Record<string, string | undefined>): Pool => {
  const p = pool(env);
  pools.push(p);
  return p;
};
after(() => (pools.forEach((p) => p.stopAll()), proc.killAll()));

test('lsp: definition, references, hover and diagnostics, from the editor’s copy', async () => {
  const p = fresh();
  const root = tmp('lsp-');
  const a = path.join(root, 'math.js');
  const b = path.join(root, 'use.js');
  fs.writeFileSync(a, 'export function add(a, b) {\n  return a + b; // TODO tests\n}\n');
  fs.writeFileSync(b, "import { add } from './math.js';\nconst twice = (x) => add(x, x);\n");
  const d = await ask(p, root, 'diagnostics', a, fs.readFileSync(a, 'utf8'));
  assert.equal(d.lsp, 'TypeScript');
  assert.ok('diagnostics' in d);
  assert.deepEqual(d.diagnostics.map((x) => [x.line, x.severity, x.message]), [[2, 'warning', 'Something is left to do']]);
  const def = await ask(p, root, 'definition', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.ok('hits' in def);
  assert.deepEqual(def.hits.map((h) => [h.path, h.line, h.col]), [['math.js', 1, 17]]);
  assert.match(def.hits[0]?.text ?? '', /export function add/);
  const refs = await ask(p, root, 'references', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.ok('hits' in refs);
  assert.deepEqual(refs.hits.map((h) => `${h.path}:${h.line}`).sort(), ['math.js:1', 'use.js:1', 'use.js:2']);
  const hover = await ask(p, root, 'hover', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.ok('hover' in hover);
  assert.match(hover.hover, /function add\(a: number, b: number\): number/);
  const comp = await ask(p, root, 'completion', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.ok('items' in comp);
  assert.deepEqual(comp.items.map((x) => x.insert), ['add', 'addAll']);
  // Rename: every place, in every file it knows, written
  const ren = await ask(p, root, 'rename', b, fs.readFileSync(b, 'utf8'), 2, 23, { newName: 'sum' });
  assert.ok('files' in ren);
  assert.deepEqual(ren.files.sort(), ['math.js', 'use.js']);
  assert.equal(ren.count, 3);
  assert.match(fs.readFileSync(a, 'utf8'), /export function sum\(a, b\)/);
  assert.equal(fs.readFileSync(b, 'utf8'), "import { sum } from './math.js';\nconst twice = (x) => sum(x, x);\n");
  // Unsaved edits are what it reads
  const edited = await ask(p, root, 'diagnostics', a, 'export function add(a, b) {\n  return a + b;\n}\n');
  assert.equal(edited.lsp, 'TypeScript');
  assert.equal(p.size, 1, 'one server per folder and language');
});

test('lsp: no server for the language, or none installed: the page keeps its text search', async () => {
  assert.equal(langOf('a.tsx'), 'ts');
  assert.equal(langOf('a.py'), 'py');
  assert.equal(langOf('README.md'), null);
  const root = tmp('lsp-none-');
  fs.writeFileSync(path.join(root, 'x.md'), '# hi');
  const p = fresh({ PATH: root }); // nothing installed anywhere
  assert.deepEqual(await ask(p, root, 'hover', path.join(root, 'x.md'), '# hi'), { lsp: null, lang: null, install: null });
  assert.equal(await findServer('go', root, { env: { PATH: root }, platform: process.platform, home: null }), null);
  const r = await ask(p, root, 'definition', path.join(root, 'x.py'), 'x = 1');
  assert.deepEqual(r, { lsp: null, lang: 'py', install: 'Python' }, 'Python: wisp can install pyright');
});

test('lsp: the repo’s own server first, then wisp’s, then PATH', async () => {
  const root = tmp('lsp-find-');
  const home = tmp('lsp-home-');
  const bin = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'typescript-language-server');
    fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
    return f;
  };
  const onPath = bin(path.join(tmp('lsp-path-'), 'bin'));
  const where = { env: { PATH: path.dirname(onPath) }, platform: 'darwin', home };
  assert.deepEqual(await findServer('ts', root, where), [onPath, '--stdio']);
  const wisps = bin(path.join(home, 'lsp', 'node_modules', '.bin'));
  assert.deepEqual(await findServer('ts', root, where), [wisps, '--stdio']);
  const repos = bin(path.join(root, 'node_modules', '.bin'));
  assert.deepEqual(await findServer('ts', root, where), [repos, '--stdio']);
  assert.deepEqual(installArgs('py', home)?.args.slice(-1), ['pyright']);
  assert.equal(installArgs('go', home), null, 'gopls is yours to install');
});

const session = (cwd: string, state: Session['state'] = 'review'): Session => ({ id: 's1', title: '', agent: 'claude', model: '', effort: '', mode: 'edits', cwd, dirs: [], state, unread: false, archived: false, createdAt: 0, updatedAt: 0, queue: [], ext: {} }) as unknown as Session;

test('the route’s checks: a known op, a file of the task’s, a rename only to a name and not while the agent works', async () => {
  const root = tmp('lsp-route-');
  fs.writeFileSync(path.join(root, 'a.js'), 'export function add() {}\n');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '');
  fs.symlinkSync(tmpdir(), path.join(root, 'out'));
  const d = { pool: fresh(), home: root, proc: { exec: async () => ({ code: 0, stderr: '' }) }, folders: () => [] };
  const status = (e: unknown): number => (e as { status: number }).status;
  await assert.rejects(askFor(d, session(root), { id: 's1', op: 'nope' as 'hover', path: 'a.js' }), (e) => status(e) === 400);
  for (const p of ['../x.js', '/etc/passwd', '.git/config', 'out/x.js', 'gone.js']) await assert.rejects(askFor(d, session(root), { id: 's1', op: 'hover', path: p }), (e) => status(e) === 404, p);
  assert.equal(await sourceFile(root, 'a.js'), path.join(root, 'a.js'));
  await assert.rejects(askFor(d, session(root, 'running'), { id: 's1', op: 'rename', path: 'a.js', newName: 'b' }), (e) => status(e) === 409);
  await assert.rejects(askFor(d, session(root), { id: 's1', op: 'rename', path: 'a.js', newName: 'not a name' }), (e) => status(e) === 400);
  const ok = await askFor(d, session(root), { id: 's1', op: 'hover', path: 'a.js', line: 1, col: 17 });
  assert.equal(ok.lsp, 'TypeScript');
  const wt = tmp('lsp-wt-');
  fs.writeFileSync(path.join(wt, 'only-here.js'), '');
  const viaWorktree = { ...d, folders: () => [{ id: 'wt', folder: async () => ({ dir: wt, root: wt, gone: false }) }] };
  assert.equal((await askFor(viaWorktree, session(root), { id: 's1', op: 'diagnostics', path: 'only-here.js' })).lsp, 'TypeScript', 'the worktree is the root');
});

test('install: npm into <home>/lsp, one at a time, npm’s last lines when it fails', async () => {
  const home = tmp('lsp-install-');
  let release = (): void => {};
  const calls: string[][] = [];
  const proc = { exec: async (_b: string, args: readonly string[]) => (calls.push([...args]), await new Promise<void>((r) => (release = r)), { code: 1, stderr: 'a\nb\nc\nnpm ERR! 404 nope\n' }) };
  const install = installer({ home, proc });
  await assert.rejects(install('go'), /install others yourself/);
  const first = install('ts');
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(install('py'), (e) => (e as { status: number }).status === 409);
  release();
  await assert.rejects(first, /Couldn’t install: b c npm ERR! 404 nope/);
  assert.deepEqual(calls[0]?.slice(-2), ['typescript@5', 'typescript-language-server']);
  assert.ok(fs.existsSync(path.join(home, 'lsp')));
});
