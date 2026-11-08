import { expect, test } from 'vitest';
import { namespaceOf, viewIntent } from '../src/define.ts';
import { createTheme } from '../src/theme.ts';
import { signal } from '@wisp/client';

test('built-ins use the name after wisp.; others their own id', () => {
  expect(namespaceOf('wisp.crew')).toBe('crew');
  expect(namespaceOf('acme.tool')).toBe('acme.tool');
});

test('viewIntent opens a view from its definition alone', () => {
  expect(viewIntent({ kind: 'crew.board', slot: 'main' }, { tab: 1 })).toEqual({ t: 'openView', id: 'crew.board', params: { tab: 1 } });
  expect(viewIntent({ kind: 'git.pane', slot: 'side' }, null)).toEqual({ t: 'openSide', side: { kind: 'view', id: 'git.pane' } });
  expect(viewIntent({ kind: 'stuff.viewer', slot: 'overlay', overlay: 'viewer' }, { id: 'x' })).toEqual({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'stuff.viewer', params: { id: 'x' } } });
});

test('theme: data-theme follows the setting, system follows the OS, a locked theme says who', async () => {
  const pref = signal<string | undefined>(undefined);
  const lock = signal<string | undefined>(undefined);
  const attrs = new Map<string, string>();
  const listeners: (() => void)[] = [];
  const os = { matches: false, addEventListener: (_: 'change', fn: () => void) => listeners.push(fn), removeEventListener: () => {} };
  const stored = new Map<string, string>();
  const locked: string[] = [];
  const th = createTheme({
    pref, lockedBy: lock, write: async (p) => pref(p),
    root: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) },
    dark: os, storage: { setItem: (k, v) => stored.set(k, v) }, onLocked: (by) => locked.push(by),
  });
  expect(th.pref()).toBe('system');
  expect(attrs.has('data-theme')).toBe(false);
  await th.set('dark');
  expect(attrs.get('data-theme')).toBe('dark');
  expect(stored.get('wisp.theme')).toBe('dark');
  await th.set('system');
  os.matches = true;
  for (const l of listeners) l();
  expect(th.resolved()).toBe('dark');
  lock('wisp.spell');
  await th.set('light');
  expect(locked).toEqual(['wisp.spell']);
  expect(th.pref()).toBe('system');
});
