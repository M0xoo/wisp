import assert from 'node:assert/strict';
import test from 'node:test';
import { testImports } from '../rules/test-imports.ts';
import { fixture, messages, run } from './helpers.ts';

test('test-imports: a UI *.test.ts reaching a .tsx directly, through a module or a package root fails; /pure, type-only, lazy, .test.tsx and allow-listed renders pass', async () => {
  const root = fixture('test-imports');
  assert.deepEqual(await run(testImports, root), [
    'packages/shell/test/barrel.test.ts:2 test-imports', // @wisp/ui root → Button.tsx
    'packages/shell/test/through.test.ts:1 test-imports', // ../src/menu.ts → @wisp/ui → Button.tsx
    'packages/ui/test/direct.test.ts:1 test-imports', // ../src/Button.tsx
  ]);
  const all = (await messages(testImports, root)).join('\n');
  assert.match(all, /packages\/shell\/src\/menu\.ts → packages\/ui\/src\/index\.ts → packages\/ui\/src\/Button\.tsx/);
  assert.match(all, /a \/pure entry/);
});
