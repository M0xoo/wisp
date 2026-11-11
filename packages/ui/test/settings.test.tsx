import { describe, expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, part, tick } from './helpers.tsx';
import { Meter, SettingsFrame, SettingsGroup, type SettingsNavGroup } from '../src/settings/index.ts';

const GROUPS: readonly SettingsNavGroup[] = [
  { id: 'a', items: [{ id: 'general', label: 'General', icon: 'settings' }, { id: 'theme', label: 'Appearance', icon: 'sun' }] },
  { id: 'b', label: 'Agents', items: [{ id: 'accounts', label: 'Accounts', icon: 'user', alert: 'bad', alertLabel: '1 not found' }] },
];

function frame(onPick = vi.fn(), view: 'list' | 'pane' = 'pane') {
  const [cur, setCur] = createSignal('general');
  const pick = (id: string): void => {
    onPick(id);
    setCur(id);
  };
  const host = mount(() => (
    <SettingsFrame title="Settings" groups={GROUPS} current={cur()} onPick={pick} paneTitle="General" lede="Lede" view={view} onUp={() => {}} upLabel="All settings" onClose={() => {}} closeLabel="Close">
      <span data-testid="body">Body</span>
    </SettingsFrame>
  ));
  return { host, cur };
}

describe('SettingsFrame', () => {
  test('renders its parts, the groups and the current pane', () => {
    frame();
    expect(part('settings.frame')?.dataset['view']).toBe('pane');
    expect(part('settings.frame.nav')).not.toBeNull();
    expect(part('settings.frame.head')?.getAttribute('data-kit')).toBe('bar');
    expect(document.querySelectorAll('[data-part="settings.frame.item"]').length).toBe(3);
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('General');
    expect(document.querySelector('[data-kit="settings-nav-group-label"]')?.textContent).toBe('Agents');
  });

  test('an alert dot has a name', () => {
    frame();
    const dot = document.querySelector('[data-kit="settings-nav-alert"]');
    expect(dot?.getAttribute('aria-label')).toBe('1 not found');
    expect(dot?.getAttribute('data-tone')).toBe('bad');
  });

  test('clicking a pane picks it', () => {
    const onPick = vi.fn();
    frame(onPick);
    document.querySelector<HTMLElement>('[data-pane="accounts"]')?.click();
    expect(onPick).toHaveBeenCalledWith('accounts');
  });

  test('ArrowDown and ArrowUp walk the panes and wrap', () => {
    const onPick = vi.fn();
    const { cur } = frame(onPick);
    const item = document.querySelector<HTMLElement>('[data-pane="general"]');
    item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(cur()).toBe('theme');
    document.querySelector<HTMLElement>('[data-pane="theme"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    document.querySelector<HTMLElement>('[data-pane="general"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(cur()).toBe('accounts');
  });

  test('labels are control text: one line', () => {
    frame();
    for (const el of document.querySelectorAll('[data-kit="settings-nav-label"], [data-kit="settings-pane-title"]')) expect(el.getAttribute('data-text')).toBe('control');
  });
});

describe('SettingsGroup', () => {
  test('a head only when it has a title or actions', () => {
    mount(() => (
      <>
        <SettingsGroup part="t.plain">rows</SettingsGroup>
        <SettingsGroup part="t.head" title="Plan budget" description="Windows">rows</SettingsGroup>
      </>
    ));
    expect(part('t.plain.head')).toBeNull();
    expect(part('t.head.head')?.textContent).toContain('Plan budget');
    expect(part('t.head.body')?.textContent).toBe('rows');
  });
});

describe('Meter', () => {
  test('a meter role with its value, clamped', () => {
    mount(() => (
      <>
        <Meter part="t.m1" label="5-hour window" value={0.425} mark={0.8} />
        <Meter part="t.m2" label="Over" value={1.7} />
        <Meter part="t.m3" label="NaN" value={Number.NaN} />
      </>
    ));
    const m1 = part('t.m1');
    expect(m1?.getAttribute('role')).toBe('meter');
    expect(m1?.getAttribute('aria-valuenow')).toBe('43');
    expect(m1?.style.getPropertyValue('--k-v')).toBe('42.5%');
    expect(part('t.m1.mark')?.style.getPropertyValue('--k-m')).toBe('80%');
    expect(part('t.m2')?.getAttribute('aria-valuenow')).toBe('100');
    expect(part('t.m3')?.getAttribute('aria-valuenow')).toBe('0');
    expect(part('t.m2.mark')).toBeNull();
  });
});

describe('bound setting rows', () => {
  test('a switch shows the value and sets it', async () => {
    const { SwitchSetting } = await import('../src/settings/index.ts');
    const { signal } = await import('alien-signals');
    const v = signal(false);
    const set = vi.fn((x: boolean) => v(x));
    mount(() => <SwitchSetting part="t.sw" title="Worktree per task" source={{ value: v, set }} />);
    (document.querySelector('[data-part="t.sw"] [data-part="ui.switch"]') as HTMLElement).click();
    await tick(10);
    expect(set).toHaveBeenCalledWith(true);
  });

  test('a locked setting is disabled and says who set it', async () => {
    const { SwitchSetting, ChoiceSetting } = await import('../src/settings/index.ts');
    const set = vi.fn();
    mount(() => (
      <>
        <SwitchSetting part="t.lk" title="Learn" source={{ value: () => true, lockedBy: () => 'Focus', set }} locked={(by) => `Set by the plugin ${by}`} />
        <ChoiceSetting part="t.ch" title="Theme" source={{ value: () => 'dark', lockedBy: () => 'Focus', set }} locked={(by) => `Set by ${by}`} items={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </>
    ));
    expect(document.querySelector('[data-part="t.lk"] [data-part="settings.locked"]')?.textContent).toBe('Set by the plugin Focus');
    (document.querySelector('[data-part="t.lk"] [data-part="ui.switch"]') as HTMLElement).click();
    await tick(10);
    document.querySelector<HTMLElement>('[data-part="t.ch"] [role="tab"][data-value="light"], [data-part="t.ch"] button[role="tab"]')?.click();
    expect(set).not.toHaveBeenCalled();
  });
});
