// A cloud computer's agents to sign in to from here (words.ts signable; v1 cloud.js signable).
import { expect, test } from 'vitest';
import type { HarnessRow } from '../src/types.ts';
import { signable } from '../src/words.ts';

const h = (id: string, ord: number, more: Partial<HarnessRow> = {}): HarnessRow => ({ id, name: id, ord, available: true, models: [], signIn: 'cli', ...more });

test('machine_agents_lists_found_cli_sign_ins_in_wisps_order', () => {
  const rows = [h('codex', 2), undefined, h('claude', 1), h('opencode', 3, { signIn: 'key' }), h('grok', 4, { available: false })];
  expect(signable(rows).map((x) => x.id)).toEqual(['claude', 'codex']);
  expect(signable([])).toEqual([]);
});
