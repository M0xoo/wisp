// A new worktree brings what git ignores (.worktreeinclude, else .env files) and runs the repo's setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from './helpers.js';
import { matcher, prepareWorktree, setupCommands } from '../server/worktree-setup.js';

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
