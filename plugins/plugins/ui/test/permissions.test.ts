// ADR-0046: an installed plugin says what it asks for, in words, before you switch it on.
import { expect, test } from 'vitest';
import { permissionWords } from '../src/commands.ts';
import en from '../src/i18n/en.json';

const say = (k: string, v?: Readonly<Record<string, string>>): string => ((en as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_m, n: string) => v?.[n] ?? '');

test('an_installed_plugins_permissions_read_as_words_before_it_is_switched_on', () => {
  expect(permissionWords('proc:exec{bin:git}', say)).toBe('run git on this computer');
  expect(permissionWords('proc:exec', say)).toBe('run * on this computer');
  expect(permissionWords('settings:read', say)).toBe('read your settings');
  expect(permissionWords('runtime:create', say)).toBe('runtime create');
  expect(permissionWords('a strange one', say)).toBe('a strange one');
});
