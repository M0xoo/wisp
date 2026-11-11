import { expect, test } from 'vitest';
import { changeLines, formatOf, groups, kindCounts, picked, type Plan } from '../src/model.ts';

test('setup_import_reads_the_plan_as_cards_and_applies_only_whats_ticked', () => {
  expect([formatOf('wisp: 1\n'), formatOf(' {"wisp":1}'), formatOf('wisp = 1\n')]).toEqual(['yaml', 'json', 'toml']);
  const kinds = [
    { kind: 'agent', section: 'agents', scope: 'shared', order: 2 },
    { kind: 'crew', section: 'crew', scope: 'shared', order: 1 },
    { kind: 'account', section: 'accounts', scope: 'personal', order: 0 },
  ];
  const have = [{ kind: 'crew', name: 'ada', spec: {} }, { kind: 'agent', name: 'fast', spec: {} }, { kind: 'agent', name: 'deep', spec: {} }, { kind: 'account', name: 'me', spec: {} }];
  expect(kindCounts(kinds, have)).toEqual([
    { kind: 'crew', section: 'crew', count: 1 },
    { kind: 'agent', section: 'agents', count: 2 },
  ]);
  const plan: Plan = {
    unchanged: 1,
    ops: [
      { op: 'create', kind: 'crew', name: 'bob', spec: {} },
      { op: 'update', kind: 'agent', name: 'fast', spec: {}, changes: [{ path: '/model', from: 'sonnet', to: 'opus' }] },
      { op: 'create', kind: 'trigger', name: 'ci', spec: {} },
    ],
  };
  expect(groups(plan).map((g) => [g.id, g.ops.length])).toEqual([
    ['create', 2],
    ['update', 1],
  ]);
  expect(changeLines(plan.ops[1]!)).toEqual(['model: sonnet → opus']);
  const pasted = [{ kind: 'crew', name: 'bob', spec: {} }, { kind: 'agent', name: 'fast', spec: {} }, { kind: 'trigger', name: 'ci', spec: {} }, { kind: 'agent', name: 'same', spec: {} }];
  expect(picked(pasted, plan, new Set(['trigger/ci'])).map((r) => r.name)).toEqual(['bob', 'fast']);
});
