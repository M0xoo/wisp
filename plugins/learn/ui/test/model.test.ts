import { expect, test } from 'vitest';
import { rememberedLine, scopes, withItem, without, type View } from '../src/model.ts';

const empty = { preferences: [], lessons: [] };
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => (v ? `${k}${JSON.stringify(v)}` : k);

test('the_memory_pane_counts_what_is_remembered_lists_scopes_and_edits_one_list', () => {
  const v: View = {
    global: { preferences: ['Small PRs'], lessons: [] },
    projects: { '/w/zeta': { preferences: [], lessons: ['Run the migrations first'] }, '/w/alpha': { preferences: ['Use pnpm'], lessons: [] }, '/w/empty': empty },
    history: [{ id: 'r', sessionId: 's', title: 'Fix', project: '/w/alpha', agent: 'claude', turns: 3, at: 7, status: 'learned', added: [], removed: [] }],
    enabled: true,
  };
  expect(rememberedLine(v, (at) => `T${at}`, t)).toBe('learn.things{"count":3} · learn.lastRetro{"when":"T7"}');
  expect(rememberedLine({ ...v, global: empty, projects: {}, history: [] }, String, t)).toBe('learn.nothing');
  expect(scopes(v).map((s) => s.name || s.scope)).toEqual(['global', 'alpha', 'zeta']);
  expect(withItem(['a'], '  b ')).toEqual(['a', 'b']);
  expect(withItem(['a'], 'a')).toEqual(['a']);
  expect(withItem(['a'], '  ')).toEqual(['a']);
  expect(without(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
});
