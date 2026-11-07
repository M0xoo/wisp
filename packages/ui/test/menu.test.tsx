import { describe, expect, test, vi } from 'vitest';
import { mount, part, tick } from './helpers.tsx';
import { ContextMenu, Menu, type MenuEntry } from '../src/controls/Menu.tsx';

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
