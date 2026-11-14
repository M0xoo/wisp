import assert from 'node:assert/strict';
import test from 'node:test';
import { directive, noAny } from '../rules/no-any.ts';
import { MAX_FILE, MAX_FUNCTION, sizes } from '../rules/sizes.ts';
import { fixture, messages, run, writeTree } from './helpers.ts';

test('no-any: explicit any and ts-ignore/nocheck directives are errors; prose and expect-error are not', async () => {
  assert.deepEqual(await run(noAny, fixture('quality')), [
    'packages/q/src/any.ts:2 no-any',
    'packages/q/src/any.ts:3 no-any',
    'packages/q/src/any.ts:4 no-any',
    'packages/q/src/any.ts:5 no-any',
    'packages/q/src/any.ts:7 no-any',
    'packages/q/src/nocheck.ts:1 no-any',
  ]);
});

test('no-any: directive matching follows tsc', () => {
  assert.equal(directive('// @ts-ignore'), 'ignore');
  assert.equal(directive('/// @ts-ignore'), 'ignore');
  assert.equal(directive('/** @ts-ignore */'), 'ignore');
  assert.equal(directive('/*\n * @ts-nocheck\n */'), 'nocheck');
  assert.equal(directive('// see @ts-ignore'), undefined);
  assert.equal(directive('// @ts-expect-error reason'), undefined);
});

function lines(n: number, make: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => make(i)).join('\n');
}

test('sizes: files over 400 lines and functions over 60 warn, unless a size-ok reason is written', async () => {
  const body = lines(MAX_FUNCTION, (i) => `  const v${i} = ${i};`);
  const root = writeTree(
    new Map([
      ['packages/s/package.json', '{"name":"@f/s"}'],
      ['packages/s/src/long.ts', lines(MAX_FILE + 1, (i) => `export const c${i} = ${i};`)],
      ['packages/s/src/long-ok.ts', `// size-ok: a generated table, one row per v1 route\n${lines(MAX_FILE + 1, (i) => `export const c${i} = ${i};`)}`],
      ['packages/s/src/fn.ts', `export function big() {\n${body}\n}\nexport const arrow = () => {\n${body}\n};\nexport function small() {\n  return 1;\n}`],
      ['packages/s/src/fn-ok.ts', `// size-ok: one switch over every message kind\nexport function big() {\n${body}\n}\nexport const obj = {\n  // size-ok: same\n  method() {\n${body}\n  },\n};`],
      ['packages/s/src/exact.ts', `export function edge() {\n${lines(MAX_FUNCTION - 2, (i) => `  const v${i} = ${i};`)}\n}`],
    ]),
  );
  const found = await messages(sizes, root);
  assert.deepEqual(found, [
    `packages/s/src/fn.ts:1 warn:sizes big is ${MAX_FUNCTION + 2} lines (soft cap ${MAX_FUNCTION})`,
    `packages/s/src/fn.ts:${MAX_FUNCTION + 3} warn:sizes arrow is ${MAX_FUNCTION + 2} lines (soft cap ${MAX_FUNCTION})`,
    `packages/s/src/long.ts:1 warn:sizes ${MAX_FILE + 1} lines (soft cap ${MAX_FILE}): split it, or say why with // size-ok:`,
  ]);
});
