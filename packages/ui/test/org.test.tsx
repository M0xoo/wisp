// The crew's Org chart (crew/Org.tsx, v1 org.js).
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { OrgView, edgePath, type OrgCard } from '../src/crew/Org.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

const card = (id: string, name: string): OrgCard => ({ id, name, role: 'Reviewer', avatar: '', state: { text: 'On call' } });

test('selecting_a_member_turns_the_others_into_its_picker_add_or_take_off', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const [sel, setSel] = createSignal<string | undefined>();
  const picked: string[] = [];
  const team = new Set(['b']); // a already hands work to b
  dispose = render(
    () => (
      <OrgView
        title="Org"
        role="Who hands work to whom"
        actions={[]}
        tiers={[[card('a', 'Ada')], [card('b', 'Bea')]]}
        alone={[card('c', 'Cal')]}
        aloneLabel="Not connected"
        edges={[{ from: 'a', to: 'b', on: sel() === 'a', tip: 'Ada → Bea' }]}
        selected={sel()}
        pick={(id) => (team.has(id) ? 'remove' : 'add')}
        pickLabel={(id, how) => `${how} ${id}`}
        onSelect={setSel}
        onPick={(id) => picked.push(id)}
        side={<p>side</p>}
      />
    ),
    host,
  );
  const cardEl = (id: string): HTMLElement | null => host.querySelector(`[data-kit="org-card"][data-m="${id}"]`);
  expect(host.querySelector('[data-part="org.alone"] h5')?.textContent).toBe('Not connected');
  expect(host.querySelectorAll('[data-kit="org-pick"]').length).toBe(0); // nothing picked: no picker
  cardEl('a')?.click();
  expect(cardEl('a')?.hasAttribute('data-sel')).toBe(true);
  // the others: Bea is already a delegate (✓ takes her off), Cal can be added (+)
  expect(cardEl('b')?.querySelector('[data-kit="org-pick"]')?.getAttribute('aria-label')).toBe('remove b');
  expect(cardEl('c')?.querySelector('[data-kit="org-pick"]')?.getAttribute('aria-label')).toBe('add c');
  expect(cardEl('a')?.querySelector('[data-kit="org-pick"]')).toBeNull();
  cardEl('c')?.querySelector<HTMLButtonElement>('[data-kit="org-pick"]')?.click();
  expect(picked).toEqual(['c']);
  expect(cardEl('a')?.hasAttribute('data-sel')).toBe(true); // picking doesn't change the selection
  cardEl('a')?.click(); // again: done
  expect(host.querySelectorAll('[data-kit="org-pick"]').length).toBe(0);
});

test('an_arrow_goes_down_from_the_one_who_delegates_or_round_the_side_to_a_row_above', () => {
  const a = { x: 100, left: 50, right: 150, top: 0, bottom: 60 };
  const below = { x: 300, left: 250, right: 350, top: 120, bottom: 180 };
  expect(edgePath(a, below)).toBe('M100 60C100 90 300 90 300 120');
  // a loop's way back up leaves from the side
  expect(edgePath(below, a).startsWith('M250 150')).toBe(true);
});
