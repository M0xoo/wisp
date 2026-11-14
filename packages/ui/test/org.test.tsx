// The crew's Org chart (crew/Org.tsx, v1 org.js).
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { CrewListSection, OrgView, edgePath, placeFree, type OrgCard } from '../src/crew/Org.tsx';

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

test('the phone Crew section nests a members jobs under its row and offers the rest as "N more", without rebuilding the row_v1_cr_jobs', () => {
  const [n, setN] = createSignal(2);
  const opened: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <CrewListSection
        name="Crew"
        count={2}
        collapsed={false}
        onToggle={() => {}}
        add={{ label: 'Add', onClick: () => {} }}
        rows={[
          { id: 'ada', name: 'Ada', avatar: 'ghost', sub: 'On call', jobs: <div data-testid="card">job</div>, more: () => (n() > 0 ? `${n()} more · open Ada` : undefined) },
          { id: 'bob', name: 'Bob', avatar: 'ghost', sub: 'Idle' },
        ]}
        empty={{ title: '', sub: '' }}
        openLabel={(name) => name}
        onOpen={(id) => opened.push(id)}
      />
    ),
    host,
  );
  const members = host.querySelectorAll('[data-kit="cr-member"]');
  expect(members.length).toBe(2);
  expect(members[0]?.querySelector('[data-kit="cr-jobs"] [data-testid="card"]')).not.toBeNull();
  expect(members[1]?.querySelector('[data-kit="cr-jobs"]')).toBeNull(); // nothing under Bob
  const row = members[0]?.querySelector('[data-kit="cr-row"]');
  const more = (): HTMLButtonElement | null | undefined => members[0]?.querySelector<HTMLButtonElement>('[data-kit="cr-more"]');
  expect(more()?.textContent).toBe('2 more · open Ada');
  more()?.click();
  expect(opened).toEqual(['ada']);
  setN(0);
  expect(more()).toBeNull();
  expect(members[0]?.querySelector('[data-kit="cr-row"]')).toBe(row); // the row stayed: no rebuild
});

test('cards placed by hand sit at their spot from the middle, the rest in rows under them, none cut off on the left_v1_place_free', () => {
  // a 600px chart, 196×80 cards: Ada placed at the middle's left, Bob above her right; Cy and Di not placed yet
  const out = placeFree(['ada', 'bob', 'cy', 'di'], { ada: { x: -98, y: 0 }, bob: { x: 40, y: 120 } }, { w: 600, cw: 196, ch: 80 });
  expect(out.shift).toBe(300); // x = 0 is the middle
  expect(out.at.get('ada')).toEqual({ left: 202, top: 0 });
  expect(out.at.get('bob')).toEqual({ left: 340, top: 120 });
  // the rest: a row 40px under the lowest placed card, centred, 18px apart
  expect(out.at.get('cy')).toEqual({ left: 300 - 196 - 9, top: 240 });
  expect(out.at.get('di')).toEqual({ left: 300 + 9, top: 240 });
  expect(out.height).toBe(320);
  expect(out.minWidth).toBe(0);
  // a card far left: everything shifts right so it shows, and the box grows to scroll sideways
  const far = placeFree(['ada'], { ada: { x: -500, y: 0 } }, { w: 600, cw: 196, ch: 80 });
  expect(far.at.get('ada')?.left).toBe(0);
  // the shift holds while the width does: moving the leftmost card back doesn't slide the rest
  expect(placeFree(['ada'], { ada: { x: -100, y: 0 } }, { w: 600, cw: 196, ch: 80, shift: far.shift }).shift).toBe(500);
});
