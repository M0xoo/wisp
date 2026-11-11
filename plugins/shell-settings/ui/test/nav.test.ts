import { expect, test } from 'vitest';
import { groupPanes, type PaneEntry } from '../src/frame.tsx';

const pane = (id: string, group: string, order = 50): PaneEntry => ({ pane: { id, group, title: `t.${id}`, icon: 'settings', order, component: () => null }, client: {} as never });

test('settings_nav_is_v1s_flat_list_in_v1s_order_with_v2s_own_panes_after', () => {
  const groups = groupPanes(
    [pane('privacy', 'advanced', 30), pane('theme', 'general', 5), pane('agents', 'agents', 10), pane('general', 'general', 10), pane('updates', 'advanced', 10), pane('plugins', 'advanced', 5), pane('machine', 'computers', 50), pane('usage', 'advanced', 20), pane('auto', 'agents', 20), pane('keys', 'general', 40)],
    (k) => k,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]?.label).toBeUndefined();
  expect(groups[0]?.items.map((i) => i.id)).toEqual(['general', 'agents', 'auto', 'plugins', 'machine', 'usage', 'privacy', 'theme', 'keys', 'updates']);
  expect(groupPanes([], (k) => k)).toEqual([]);
});
