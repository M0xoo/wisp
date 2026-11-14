import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { runCheck } from '../check/index.ts';
import { create, parseArgs } from '../new-plugin.ts';

const REPO = join(import.meta.dirname, '..', '..');
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'wisp-new-plugin-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: ['packages/*', 'plugins/*/api', 'plugins/*/host', 'plugins/*/ui', 'apps/*'] }));
  return root;
}

function made(root: string, name: string, tier: 'builtin' | 'exec' = 'builtin'): string[] {
  const files = create({ name, tier, id: undefined, root });
  assert.ok(Array.isArray(files), String(files));
  return files;
}

test('parseArgs: name, tier and id are validated', () => {
  assert.deepEqual(parseArgs(['my-prs', '--tier', 'exec'], '/r'), { name: 'my-prs', tier: 'exec', id: undefined, root: '/r' });
  assert.deepEqual(parseArgs(['x', '--id=acme.x', '--root=/t'], '/r'), { name: 'x', tier: 'builtin', id: 'acme.x', root: '/t' });
  for (const bad of [[], ['My_Prs'], ['a', 'b'], ['a', '--tier', 'wasm'], ['a', '--id', 'nodots'], ['a', '--nope']]) assert.equal(typeof parseArgs(bad, '/r'), 'string', bad.join(' '));
});

test('builtin scaffold: three packages with tsconfig, src, test, a manifest and a README', () => {
  const root = tree();
  const files = made(root, 'my-prs');
  for (const half of ['api', 'host', 'ui']) {
    for (const f of ['package.json', 'tsconfig.json']) assert.ok(files.includes(`plugins/my-prs/${half}/${f}`), `${half}/${f}`);
    assert.ok(files.some((f) => f.startsWith(`plugins/my-prs/${half}/src/`)));
    assert.ok(files.some((f) => f.startsWith(`plugins/my-prs/${half}/test/`)));
  }
  assert.ok(files.includes('plugins/my-prs/README.md'));
  const names = ['api', 'host', 'ui'].map((h) => JSON.parse(readFileSync(join(root, `plugins/my-prs/${h}/package.json`), 'utf8')).name);
  assert.deepEqual(names, ['@wisp-plugin/my-prs-api', '@wisp-plugin/my-prs', '@wisp-plugin/my-prs-ui']);
  for (const h of ['api', 'host', 'ui']) {
    const scripts = JSON.parse(readFileSync(join(root, `plugins/my-prs/${h}/package.json`), 'utf8')).scripts;
    assert.ok(scripts.test && scripts.typecheck, `${h} has test and typecheck for monoflow`);
  }
  const m = JSON.parse(readFileSync(join(root, 'plugins/my-prs/host/wisp-plugin.json'), 'utf8'));
  assert.equal(m.id, 'wisp.my-prs');
  assert.deepEqual(m.server, { builtin: './src/index.ts' });
});

test('an existing plugin folder is never overwritten', () => {
  const root = tree();
  made(root, 'twice');
  const again = create({ name: 'twice', tier: 'builtin', id: undefined, root });
  assert.equal(typeof again, 'string');
});

test('the scaffold passes npm run check once its command is in a capability set', async () => {
  const root = tree();
  made(root, 'my-prs');
  const errors = async (): Promise<string[]> => (await runCheck(root)).findings.filter((f) => f.severity === 'error').map((f) => f.message.split(' (')[0] ?? '');
  assert.deepEqual(await errors(), []); // no kernel yet: default deny is a warning
  mkdirSync(join(root, 'packages/kernel/src'), { recursive: true });
  writeFileSync(join(root, 'packages/kernel/package.json'), JSON.stringify({ name: '@wisp/kernel', type: 'module', exports: { '.': './src/index.ts' } }));
  writeFileSync(join(root, 'packages/kernel/src/capabilities.ts'), "export const USER = { id: 'user:full', allow: ['*'] };\n");
  assert.deepEqual(await errors(), ['command my-prs.hello is in no capability set']);
  writeFileSync(join(root, 'packages/kernel/src/capabilities.ts'), "export const USER = { id: 'user:full', allow: ['*', 'my-prs:*'] };\n");
  assert.deepEqual(await errors(), []);
});

test("the scaffold's own api and host tests pass, builtin and exec", () => {
  for (const tier of ['builtin', 'exec'] as const) {
    const root = tree();
    made(root, 'demo', tier);
    // what npm install would link: the host imports its api by name
    mkdirSync(join(root, 'node_modules/@wisp-plugin'), { recursive: true });
    symlinkSync(join(root, 'plugins/demo/api'), join(root, 'node_modules/@wisp-plugin/demo-api'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const half of ['api', 'host']) {
      execFileSync(process.execPath, ['--test', '--test-reporter=dot', 'test/**/*.test.ts'], { cwd: join(root, 'plugins/demo', half), stdio: 'pipe' });
    }
    assert.equal(existsSync(join(root, 'plugins/demo/host/src/main.ts')), tier === 'exec');
  }
});

test("the manifests pass the kernel's validateManifest", { skip: !existsSync(join(REPO, 'packages/kernel/src/manifest.ts')) && 'no kernel validator yet' }, async () => {
  const mod: unknown = await import(pathToFileURL(join(REPO, 'packages/kernel/src/manifest.ts')).href);
  const validate = typeof mod === 'object' && mod !== null && 'validateManifest' in mod ? mod.validateManifest : undefined;
  assert.equal(typeof validate, 'function');
  for (const tier of ['builtin', 'exec'] as const) {
    const root = tree();
    made(root, 'demo', tier);
    const m: unknown = JSON.parse(readFileSync(join(root, 'plugins/demo/host/wisp-plugin.json'), 'utf8'));
    assert.deepEqual(Reflect.apply(validate as (x: unknown) => unknown, undefined, [m]), { ok: true, manifest: m }, tier);
  }
});
