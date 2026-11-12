import { describe, expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, part, tick } from './helpers.tsx';
import { ContextMenu, Menu, menuSections, type MenuEntry } from '../src/controls/Menu.tsx';

const items: MenuEntry[] = [
  { value: 'rerun', label: 'Rerun…', icon: 'rerun' },
  { value: 'done', label: 'Mark done', icon: 'check', keys: 'E' },
  { kind: 'separator' },
  { kind: 'group', id: 'move', label: 'Move', items: [{ value: 'later', label: 'Save for later', hint: 'Keep it in For later' }] },
  { value: 'delete', label: 'Delete task', icon: 'trash', danger: true },
];

const key = (el: Element | null, k: string): void => {
  el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};
const highlighted = (): string | null | undefined => document.querySelector('[data-part="task.more.item"][data-highlighted]')?.getAttribute('data-value');

function open(onSelect = vi.fn()): { trigger: HTMLElement | null; onSelect: typeof onSelect } {
  mount(() => <Menu items={items} onSelect={onSelect} trigger={{ icon: 'dots', 'aria-label': 'More' }} part="task.more" />);
  const trigger = part('task.more.trigger');
  trigger?.focus();
  return { trigger, onSelect };
}

describe('Menu', () => {
  test('renders its parts: trigger with a name, items, separator, group', async () => {
    const { trigger } = open();
    expect(trigger?.getAttribute('aria-label')).toBe('More');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    key(trigger, 'ArrowDown');
    await tick(20);
    expect(part('task.more')?.getAttribute('data-state')).toBe('open');
    expect(document.querySelectorAll('[data-part="task.more.item"]').length).toBe(4);
    expect(part('task.more.separator')).not.toBeNull();
    expect(part('task.more.group')?.textContent).toContain('Move');
    expect(document.querySelector('[data-value="delete"]')?.getAttribute('data-danger')).toBe('');
  });

  test('ArrowDown and ArrowUp move the highlight; Enter selects and closes', async () => {
    const { trigger, onSelect } = open();
    key(trigger, 'ArrowDown');
    await tick(20);
    expect(highlighted()).toBe('rerun');
    const content = part('task.more');
    key(content, 'ArrowDown');
    await tick(10);
    expect(highlighted()).toBe('done');
    key(content, 'ArrowUp');
    await tick(10);
    expect(highlighted()).toBe('rerun');
    key(content, 'ArrowDown');
    await tick(10);
    key(content, 'Enter');
    await tick(20);
    expect(onSelect).toHaveBeenCalledWith('done');
    expect(part('task.more')?.getAttribute('data-state')).toBe('closed');
  });

  test('Escape closes it and focus goes back to the trigger', async () => {
    const { trigger } = open();
    key(trigger, 'ArrowDown');
    await tick(20);
    key(part('task.more'), 'Escape');
    await tick(20);
    expect(part('task.more')?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(trigger);
  });
});

describe('ContextMenu', () => {
  test('a right click on its children opens it', async () => {
    mount(() => (
      <ContextMenu items={items} onSelect={() => {}} part="row.menu">
        <p>row</p>
      </ContextMenu>
    ));
    const area = part('row.menu.area');
    area?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await tick(20);
    expect(part('row.menu')?.getAttribute('data-state')).toBe('open');
  });
});

// v1 #786 (web/js/ui/submenu.js): a submenu drills in, its items under a Back row; → opens it, ← and Escape step back
const nested: MenuEntry[] = [
  { value: 'rename', label: 'Rename', icon: 'pen' },
  {
    kind: 'submenu',
    value: 'sub:copy',
    label: 'Copy',
    icon: 'copy',
    items: [
      { value: 'copy-id', label: 'Copy task ID' },
      { value: 'copy-resume', label: 'Copy resume command' },
    ],
  },
  { value: 'delete', label: 'Delete task', danger: true },
];
const lit = (): string | null | undefined => document.querySelector('[data-part="task.more"] [data-highlighted]')?.getAttribute('data-value');
const shown = (): (string | null)[] => [...document.querySelectorAll('[data-part="task.more"] [data-kit="menu-item"]')].map((e) => e.getAttribute('data-value') ?? e.textContent);

function openNested(onSelect = vi.fn()): { content: HTMLElement | null; onSelect: typeof onSelect } {
  mount(() => <Menu items={nested} onSelect={onSelect} trigger={{ icon: 'dots', 'aria-label': 'More' }} part="task.more" />);
  const trigger = part('task.more.trigger');
  trigger?.focus();
  key(trigger, 'ArrowDown');
  return { content: part('task.more'), onSelect };
}

describe('Menu submenus', () => {
  test('a submenu row drills in on click: its items under a Back row, the menu stays open_v1_786_submenu_drill', async () => {
    const { onSelect } = openNested();
    await tick(20);
    expect(shown()).toEqual(['rename', 'sub:copy', 'delete']);
    expect(part('task.more.sub')?.getAttribute('aria-haspopup')).toBe('menu');
    part('task.more.sub')?.click();
    await tick(20);
    expect(part('task.more')?.getAttribute('data-state')).toBe('open');
    expect(part('task.more')?.hasAttribute('data-drilled')).toBe(true);
    expect(part('task.more.back')?.textContent).toBe('Copy');
    expect(shown()).toEqual(['menu:back', 'copy-id', 'copy-resume']);
    expect(onSelect).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>('[data-value="copy-resume"]')?.click();
    await tick(20);
    expect(onSelect).toHaveBeenCalledWith('copy-resume');
    expect(part('task.more')?.getAttribute('data-state')).toBe('closed');
  });

  test('→ opens the lit submenu with its first item lit; ← steps back to its row_v1_786_submenu_arrows', async () => {
    const { content } = openNested();
    await tick(20);
    key(content, 'ArrowDown');
    await tick(10);
    expect(lit()).toBe('sub:copy');
    key(content, 'ArrowRight');
    await tick(20);
    expect(part('task.more.back')).not.toBeNull();
    expect(lit()).toBe('copy-id');
    key(content, 'ArrowLeft');
    await tick(20);
    expect(part('task.more.back')).toBeNull();
    expect(lit()).toBe('sub:copy');
    expect(part('task.more')?.getAttribute('data-state')).toBe('open');
  });

  test('Escape in a submenu steps back; a second Escape closes the menu_v1_786_submenu_escape', async () => {
    const { content } = openNested();
    await tick(20);
    key(content, 'ArrowDown');
    await tick(10);
    key(content, 'Enter');
    await tick(20);
    expect(part('task.more.back')).not.toBeNull();
    key(part('task.more'), 'Escape');
    await tick(20);
    expect(part('task.more.back')).toBeNull();
    expect(part('task.more')?.getAttribute('data-state')).toBe('open');
    key(part('task.more'), 'Escape');
    await tick(20);
    expect(part('task.more')?.getAttribute('data-state')).toBe('closed');
  });

  test('Back returns to the menu; reopening starts at the top level_v1_786_submenu_back', async () => {
    openNested();
    await tick(20);
    part('task.more.sub')?.click();
    await tick(20);
    part('task.more.back')?.click();
    await tick(20);
    expect(shown()).toEqual(['rename', 'sub:copy', 'delete']);
    part('task.more.sub')?.click();
    await tick(20);
    key(part('task.more'), 'Escape');
    key(part('task.more'), 'Escape');
    await tick(20);
    const t = part('task.more.trigger');
    t?.focus();
    key(t, 'ArrowDown');
    await tick(20);
    expect(shown()).toEqual(['rename', 'sub:copy', 'delete']);
  });
});

test('a right-click on another row while drilled in opens the menu at its top level_v1_786_submenu_reanchor', async () => {
  mount(() => (
    <ContextMenu items={nested} onSelect={() => {}} part="row.menu">
      <p data-part="row.a">a</p>
      <p data-part="row.b">b</p>
    </ContextMenu>
  ));
  const right = (el: Element | null): void => void el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  right(part('row.a'));
  await tick(20);
  part('row.menu.sub')?.click();
  await tick(20);
  expect(part('row.menu.back')).not.toBeNull();
  right(part('row.b'));
  await tick(20);
  expect(part('row.menu')?.getAttribute('data-state')).toBe('open');
  expect(part('row.menu.back')).toBeNull();
  expect(part('row.menu')?.hasAttribute('data-drilled')).toBe(false);
});

test('a submenu that folds away while open leaves the top level, and one Escape closes_v1_786_submenu_gone', async () => {
  const [items, setItems] = createSignal<MenuEntry[]>(nested);
  mount(() => <Menu items={items()} onSelect={() => {}} trigger={{ icon: 'dots', 'aria-label': 'More' }} part="task.more" />);
  const trigger = part('task.more.trigger');
  trigger?.focus();
  key(trigger, 'ArrowDown');
  await tick(20);
  part('task.more.sub')?.click();
  await tick(20);
  expect(part('task.more.back')).not.toBeNull();
  // Copy › drops to one item: menuSections shows it inline, no submenu any more
  setItems([nested[0] as MenuEntry, { value: 'copy-id', label: 'Copy task ID' }, nested[2] as MenuEntry]);
  await tick(20);
  expect(part('task.more.back')).toBeNull();
  expect(part('task.more')?.hasAttribute('data-drilled')).toBe(false);
  key(part('task.more'), 'Escape');
  await tick(20);
  expect(part('task.more')?.getAttribute('data-state')).toBe('closed');
});

test('menuSections: a line between groups, empty groups dropped, a submenu of one inline_v1_786_sections', () => {
  const sub = (value: string, items: string[]): MenuEntry => ({ kind: 'submenu', value, label: value, items: items.map((v) => ({ value: v, label: v })) });
  const m = menuSections([[{ value: 'a', label: 'a' }, false], [], [null, sub('s:one', ['only']), sub('s:none', [])], [sub('s:two', ['x', 'y'])]]);
  expect(m.map((e) => ('value' in e ? e.value : e.kind))).toEqual(['a', 'separator', 'only', 'separator', 's:two']);
  expect(menuSections([[sub('s:none', [])], []])).toEqual([]);
});
