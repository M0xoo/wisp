import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeClone, memoryBlobs, nodeProc, tmp } from '@wisp/testkit/fake-gh';
import { createGitService } from '../src/service.ts';

const scope = { signal: new AbortController().signal, alive: true, add() {}, child() { return scope; }, timeout(ms: number, fn: () => void) { setTimeout(fn, ms); }, interval() {}, dispose() {} };

test('a worktree: add, status, changes, remove', async () => {
  const c = makeClone();
  const blobs = memoryBlobs();
  const git = createGitService({ proc: nodeProc(), blob: () => blobs, scope });
  const src = await git.source(c.dir);
  assert.equal(src?.base.ref, 'origin/main');
  const home = tmp('home');
  const at = path.join(home, 'worktrees', 'clone-abc');
  const repo = await git.repo(c.dir);
  await repo.worktreeAdd({ at, branch: 'wisp/x', from: 'origin/main' });
  const wt = { path: at, cwd: at, branch: 'wisp/x', base: 'main', baseRef: 'origin/main', head: src?.base.sha ?? null, remote: 'origin', root: c.dir, createdAt: 0 };
  fs.writeFileSync(path.join(at, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(at, 'new.txt'), 'hi\n');
  assert.deepEqual(await git.worktreeStatus(wt), { exists: true, dirty: 2, ahead: 0, unpushed: 0 });
  const ch = await git.changes(wt);
  assert.deepEqual(ch?.files.map((f) => [f.path, f.status, f.add, f.del]), [['math.js', 'M', 1, 1], ['new.txt', 'A', 1, 0]]);
  const ref = await (await git.repo(at)).diff('origin/main');
  assert.ok(ref.size > 0);
  const st = await (await git.repo(at)).status();
  assert.equal(st.branch, 'wisp/x');
  assert.equal(st.dirty, 2);
  assert.deepEqual(await git.worktreeRemove(wt), { removed: false, dirty: 2 });
  assert.equal((await git.worktreeRemove(wt, { force: true })).removed, true);
  assert.equal(fs.existsSync(at), false);
  git.dispose();
});
