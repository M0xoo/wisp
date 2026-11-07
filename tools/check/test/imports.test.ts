import assert from 'node:assert/strict';
import test from 'node:test';
import { cycles, cyclePath, stronglyConnected } from '../rules/cycles.ts';
import { layers } from '../rules/layers.ts';
import { publicEntry } from '../rules/public-entry.ts';
import { fixture, messages, run } from './helpers.ts';

test('layers: each layer imports only below it, plugins meet through api', async () => {
  assert.deepEqual(await run(layers, fixture('layers')), [
    'apps/web/src/main.ts:2 layers', // page code importing a plugin host
    'apps/web/src/main.ts:3 layers', // app → app
    'packages/base/src/index.ts:1 layers', // package → plugin api
    'plugins/git/api/src/index.ts:1 layers', // node: in an api
    'plugins/git/api/src/index.ts:2 layers', // runtime library in an api
    'plugins/git/api/src/index.ts:5 layers', // module-level let in an api
    'plugins/git/api/src/index.ts:6 layers', // side effect in an api
    'plugins/wt/host/src/index.ts:2 layers', // another plugin's host
    'plugins/wt/host/src/index.ts:4 layers', // own ui from host
    'plugins/wt/ui/src/index.tsx:2 layers', // own host from ui
    'plugins/wt/ui/src/index.tsx:3 layers', // node: in ui code
  ]);
});

test('layers: messages name the way out', async () => {
  const all = (await messages(layers, fixture('layers'))).join('\n');
  assert.match(all, /import git's api, never its host \(@f\/git\)/);
  assert.match(all, /ui code runs in the page: no node:fs/);
  assert.match(all, /use import type/);
});

test('public-entry: entry and exported subpaths only, declared, no relative escapes', async () => {
  assert.deepEqual(await run(publicEntry, fixture('public-entry')), [
    'packages/store/src/index.ts:4 public-entry', // @f/kernel/src/internal/helper.ts
    'packages/store/src/index.ts:5 public-entry', // ../../kernel/src/…
    'packages/sync/src/index.ts:1 public-entry', // @f/kernel not declared
    'packages/sync/src/index.ts:2 public-entry', // ../../../shared, outside any package
  ]);
});

test('cycles: package and file cycles are reported with their path; type-only and lazy loops are not', async () => {
  const found = await messages(cycles, fixture('cycles'));
  assert.deepEqual(found, [
    'packages/a/package.json:1 cycles package cycle: @f/a → @f/b → @f/a',
    'packages/c/src/a.ts:1 cycles file cycle: src/a.ts → src/b.ts → src/c.ts → src/a.ts',
    'packages/d/src/index.ts:1 cycles file cycle: src/index.ts → src/index.ts',
  ]);
});

test('cycles: Tarjan finds every component and a concrete loop through it', () => {
  const g = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['c', 'd'])],
    ['c', new Set(['a'])],
    ['d', new Set(['e'])],
    ['e', new Set(['d'])],
    ['f', new Set(['a'])],
  ]);
  const comps = stronglyConnected(g);
  assert.deepEqual(comps.map((c) => c.join('')).sort(), ['abc', 'de']);
  assert.deepEqual(cyclePath(g, ['a', 'b', 'c'], 'a'), ['a', 'b', 'c', 'a']);
  assert.deepEqual(stronglyConnected(new Map([['x', new Set<string>()]])), []);
});
