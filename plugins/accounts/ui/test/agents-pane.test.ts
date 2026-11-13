// Settings → Agents' rules (words.ts): a missing harness's one-line install, and what Re-check turned up
// (v1 settings.js paintAgents, setup.js setupCommand, recheckSummary).
import { expect, test } from 'vitest';
import type { HarnessRow } from '../src/types.ts';
import { howToGet, recheckSummary } from '../src/words.ts';

const h = (id: string, more: Partial<HarnessRow> = {}): HarnessRow => ({ id, name: id, ord: 1, available: true, models: [], signIn: 'cli', ...more });

test('a_missing_harness_shows_the_one_line_install_for_this_os', () => {
  const setup = { tip: 'Install Claude Code and run claude once to sign in', command: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://claude.com/claude-code' };
  // found: nothing to install
  expect(howToGet(h('claude', { setup }))).toBeUndefined();
  // signed out is still found: it signs in, it doesn't install
  expect(howToGet(h('claude', { available: false, signedIn: false, setup }))).toBeUndefined();
  // not found: the OS's tip and its command to copy
  expect(howToGet(h('claude', { available: false, setup }))).toEqual({ tip: setup.tip, command: setup.command });
  // wisp installs it itself (opencode): Install, no command to copy; while it installs, the row says so instead
  expect(howToGet(h('opencode', { available: false, installable: true, setup }))).toEqual({ tip: setup.tip });
  expect(howToGet(h('opencode', { available: false, installable: true, installing: true, setup }))).toBeUndefined();
  // no tip from the harness: v1's words
  expect(howToGet(h('grok', { available: false, name: 'Grok' }))?.tip).toBe('Install the Grok CLI and sign in, then re-check');
});

test('recheck_finds_harnesses_and_models_again_and_says_what_changed', () => {
  const m = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, label: `M${i}` }));
  const before = new Map([
    ['claude', { available: true, models: m(2), version: '1.0' }],
    ['codex', { available: false, models: [], version: undefined }],
    ['grok', { available: true, models: m(1), version: '1' }],
  ] as const);
  const after = [h('claude', { name: 'Claude Code', models: m(3), version: '1.0' }), h('codex', { name: 'Codex' }), h('grok', { name: 'Grok', available: false })];
  expect(recheckSummary(before as never, after)).toBe('Claude Code +1 model · Codex found · Grok not found');
  expect(recheckSummary(new Map([['claude', { available: true, models: m(3), version: '1.0' }]]) as never, [after[0] as HarnessRow])).toBe('Up to date: nothing new');
});

test('recheck_sends_no_arguments_the_server_reads_as_none', async () => {
  const { recheck } = await import('../src/commands.ts');
  // `accounts.recheck` takes `()`: `{ peer }` was refused, so Re-check never ran
  expect((recheck as unknown as { wire: (a: unknown) => unknown }).wire({ peer: 'p1' })).toBeNull();
});
