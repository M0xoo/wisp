// A new worktree brings what git ignores (.worktreeinclude, else .env files) and runs the repo's setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from './helpers.js';
import { cloneOrCopy, matcher, prepareWorktree, setupCommands } from '../server/worktree-setup.js';

const repo = (files) => {
  const dir = tmp('wt-setup-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [f, text] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text);
  return dir;
};

test('matcher: gitignore-style lines', () => {
  const m = (line, rel, dir = false) => matcher(line)(rel, dir);
  assert.ok(m('.env', '.env'));
  assert.ok(m('.env.*', '.env.local'));
  assert.ok(!m('.env.*', '.env'));
  assert.ok(m('config/local.json', 'config/local.json'));
  assert.ok(!m('/local.json', 'config/local.json'), 'anchored at the root');
  assert.ok(m('local.json', 'config/local.json'), 'unanchored matches at any depth');
  assert.ok(m('node_modules/', 'node_modules/', true));
  assert.ok(m('**/secrets.txt', 'a/b/secrets.txt'));
  assert.equal(matcher('# a comment'), null);
  assert.equal(matcher('!keep'), null);
});

test('prepareWorktree: copies the ignored files it names (default .env*), runs the setup, says what failed', async () => {
  const root = repo({ '.gitignore': '.env*\nlocal/\nbig/\n', '.env': 'A=1', '.env.local': 'B=2', 'local/x.json': '{}', 'big/blob': 'x', 'app.js': '' });
  const dir = tmp('wt-dest-');
  let r = await prepareWorktree(root, dir);
  assert.deepEqual(r.copied.sort(), ['.env', '.env.local'], 'without .worktreeinclude: the root .env files');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'A=1');
  assert.ok(!fs.existsSync(path.join(dir, 'big')));
  fs.writeFileSync(path.join(root, '.worktreeinclude'), 'local/\n# not big\n');
  fs.mkdirSync(path.join(root, '.wisp'));
  fs.writeFileSync(path.join(root, '.wisp/worktree.json'), JSON.stringify({ setup: ['echo ok > setup-ran.txt', 'false', 'echo never > never.txt'] }));
  const dir2 = tmp('wt-dest-');
  r = await prepareWorktree(root, dir2);
  assert.deepEqual(r.copied, ['local']);
  assert.ok(fs.existsSync(path.join(dir2, 'local/x.json')));
  assert.ok(fs.existsSync(path.join(dir2, 'setup-ran.txt')), 'setup runs in the new worktree');
  assert.deepEqual(r.ran, ['echo ok > setup-ran.txt']);
  assert.match(r.problems[0], /setup `false` failed/);
  assert.ok(!fs.existsSync(path.join(dir2, 'never.txt')), 'a failed step stops the rest');
});

test('setupCommands: wisp’s own file, else Cursor’s', () => {
  const root = repo({ '.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['npm ci'] }) });
  assert.deepEqual(setupCommands(root), ['npm ci']);
  fs.mkdirSync(path.join(root, '.wisp'));
  fs.writeFileSync(path.join(root, '.wisp/worktree.json'), JSON.stringify({ setup: 'pnpm i' }));
  assert.deepEqual(setupCommands(root), ['pnpm i']);
});

// A folder with a nested file, an executable and a relative symlink, to check a copy keeps them.
const tree = () => {
  const root = tmp('wt-cow-');
  fs.mkdirSync(path.join(root, 'deps/pkg/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deps/pkg/index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'deps/pkg/bin/run'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    fs.symlinkSync('pkg/index.js', path.join(root, 'deps/link'));
  } catch {} // Windows without the right to make symlinks
  return root;
};
const same = (from, to) => {
  assert.equal(fs.readFileSync(path.join(to, 'pkg/index.js'), 'utf8'), 'module.exports = 1;\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(to, 'pkg/bin/run')).mode & 0o111, 0o111, 'still executable');
  if (fs.existsSync(path.join(from, 'link'))) assert.equal(fs.readlinkSync(path.join(to, 'link')), 'pkg/index.js', 'the symlink as it was');
};

test('cloneOrCopy: without copy-on-write (Windows, a cp that fails or is missing) it is a plain copy', async () => {
  const root = tree();
  const from = path.join(root, 'deps');
  for (const [i, opts] of [{ platform: 'win32' }, { platform: 'linux', cp: path.join(root, 'no-such-cp') }, { platform: 'darwin', cp: process.execPath }].entries()) {
    const to = path.join(root, `out${i}`);
    assert.equal(await cloneOrCopy(from, to, opts), false, `${opts.platform}: nothing shared`);
    same(from, to);
  }
});

test('cloneOrCopy: a cp that gives up halfway leaves nothing behind it, then the copy is whole', { skip: process.platform === 'win32' && 'a shell script as cp' }, async () => {
  const root = tree();
  const fake = path.join(root, 'cp');
  // no reflink here: GNU cp has already made the folder and some files when it fails
  fs.writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nmkdir -p "$last" && echo partial > "$last/stray"\nexit 1\n', { mode: 0o755 });
  const to = path.join(root, 'out');
  assert.equal(await cloneOrCopy(path.join(root, 'deps'), to, { platform: 'linux', cp: fake }), false);
  same(path.join(root, 'deps'), to);
  assert.ok(!fs.existsSync(path.join(to, 'stray')), 'the half copy is gone');
});

test('cloneOrCopy: this system’s own copy keeps the tree as it was', async () => {
  const root = tree();
  const to = path.join(root, 'out');
  await cloneOrCopy(path.join(root, 'deps'), to);
  same(path.join(root, 'deps'), to);
});

test('prepareWorktree: an included folder on APFS is cloned, and says how many bytes', { skip: process.platform !== 'darwin' && 'APFS' }, async () => {
  const root = repo({ '.gitignore': 'node_modules/\n', '.worktreeinclude': 'node_modules/\n', 'node_modules/a/index.js': 'x'.repeat(100_000) });
  const dir = tmp('wt-dest-');
  const r = await prepareWorktree(root, dir);
  assert.deepEqual(r.copied, ['node_modules']);
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules/a/index.js'), 'utf8').length, 100_000);
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules/node_modules')), 'the folder, not a folder inside it');
  assert.ok(r.cloned >= 100_000, `cloned ${r.cloned}`);
});
