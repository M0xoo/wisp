// The mock's wisp-git (dev/mock-git.ts): what the Changes pane reads under `npm run dev` and qa/parity.mjs.
import { afterEach, expect, test } from 'vitest';
import { gitChanges, gitCommit, gitRevert, gitStage, resetGit, rowsOf, type GitCtx } from '../dev/mock-git.ts';

afterEach(() => resetGit());

test('a file before and after reads as git rows: the shared start and end kept, the middle removed then added', () => {
  expect(rowsOf('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: '-', text: 'b', a: 2 },
    { op: '+', text: 'B', b: 2 },
    { op: ' ', text: 'c', a: 3, b: 3 },
  ]);
  expect(rowsOf('', 'hi\n')).toEqual([{ op: '+', text: 'hi', b: 1 }]); // a new file: no phantom removed blank line
});

const ctx: GitCtx = {
  turnsOf: (dir) =>
    dir === '/w'
      ? [
          { changes: [{ file: 'math.js', beforeFile: 'x\na - b\n', edits: [{ before: 'a - b', after: 'a + b' }] }] },
          { changes: [{ file: 'new.txt', edits: [{ before: '', after: 'hi' }] }] },
        ]
      : undefined,
  base: () => 'main',
};
type Read = { body: { files: { path: string; status: string; add: number; del: number; staged: boolean }[] } };
const read = (): Read['body']['files'] => (gitChanges({ path: '/w', base: 'main', stageState: true }, ctx) as Read).body.files;

test('stage, revert and commit change what the next git.changes says, and reset starts over', () => {
  expect(gitChanges({ path: '/elsewhere' }, ctx)).toBeNull();
  expect(read().map((f) => [f.path, f.status, f.add, f.del, f.staged])).toEqual([
    ['math.js', 'M', 1, 1, false],
    ['new.txt', 'A', 1, 0, false],
  ]);
  gitStage({ dir: '/w', base: 'main', path: 'math.js' });
  expect(read().map((f) => f.staged)).toEqual([true, false]);
  gitCommit({ dir: '/w', message: 'Fix', all: false }); // only the staged one goes in
  expect(read().map((f) => f.path)).toEqual(['new.txt']);
  gitRevert({ dir: '/w', base: 'main', path: 'new.txt' });
  expect(read()).toEqual([]);
  resetGit();
  expect(read().length).toBe(2);
  gitCommit({ dir: '/w', message: 'All', all: true }); // nothing staged: Commit takes every change
  expect(read()).toEqual([]);
});
