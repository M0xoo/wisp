// The mock peer answers what the UI sends (round 149: `accounts.list` toasted "the mock peer has no …" on Home, in
// every screenshot and parity shot). Every command a UI package defines (`defineCommand({ id })` in packages/*/src and
// plugins/*/ui/src, found as tools/check's ui-commands rule finds them: commandsIn there) is answered by dev/mock-commands.ts or listed in
// dev/mock-reads.ts' NOT_MOCKED with why; what the main screens send on open is always answered.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { COMMANDS, type CommandCtx } from '../dev/mock-commands.ts';
import { NOT_MOCKED } from '../dev/mock-reads.ts';
import { seed } from '../dev/seed.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** `defineCommand(… id: 'x' …)`: as tools/check/rules/ui-commands.ts reads them (a test can't import tools/). */
const commandsIn = (text: string): string[] =>
  [...text.matchAll(/defineCommand\b/g)].flatMap((m) => {
    const at = (m.index ?? 0) + m[0].length;
    const id = /id:\s*'([^']+)'/.exec(text.slice(at, at + 400))?.[1];
    return id ? [id] : [];
  });

const dirs = (d: string): string[] => readdirSync(join(ROOT, d)).filter((n) => statSync(join(ROOT, d, n)).isDirectory());

/** Every command id the shell and plugin UIs define. */
const uiCommands = (): Set<string> =>
  new Set(
    [...dirs('packages').map((d) => join(ROOT, 'packages', d, 'src')), ...dirs('plugins').map((d) => join(ROOT, 'plugins', d, 'ui', 'src'))]
      .flatMap((d) => walk(d))
      .flatMap((f) => commandsIn(readFileSync(f, 'utf8'))),
  );

/** What Home, a task (its Changes, Shell, Preview sides), crew, My Stuff and every Settings pane send on open, as
 * the mock in Chrome showed it (/tmp probe over the mock at 1440: every `mutate` the page posted). */
const ON_OPEN = [
  'plugins.ui', 'runtime.agents', 'automations.tasks', 'router.preview', 'budget.view', 'accounts.list', 'stuff.launch', // Home
  'runtime.cold', 'git.changes', 'terminal.shell.info', 'terminal.shell.start', 'terminal.input', 'terminal.run.info', // a task
  'crew.layout', // crew
  'terminal.apps', 'machines.reachable', 'learn.view', 'automations.trigger.ls', 'plugins.list', 'runtime.usage', 'budget.compare',
  'settings.list', 'sandbox.info', 'resources.kinds', 'resources.export', // Settings panes
];

test('every command the UI defines is answered by the mock or listed as not mocked, with a reason', () => {
  const ui = uiCommands();
  expect(ui.size).toBeGreaterThan(100); // the extraction found the UI (not an empty walk)
  const missing = [...ui].filter((id) => !(id in COMMANDS) && !NOT_MOCKED[id]?.trim()).sort();
  expect(missing, 'answer these in apps/web/dev/mock-commands.ts, or list them in mock-reads.ts NOT_MOCKED with why').toEqual([]);
});

test('NOT_MOCKED lists only commands the UI defines and the mock does not answer', () => {
  const ui = uiCommands();
  const stale = Object.keys(NOT_MOCKED).filter((id) => !ui.has(id) || id in COMMANDS);
  expect(stale).toEqual([]);
});

test('what the main screens send on open is answered, never left to toast', () => {
  expect(ON_OPEN.filter((id) => !(id in COMMANDS))).toEqual([]);
  expect(ON_OPEN.filter((id) => id in NOT_MOCKED)).toEqual([]);
});

test('accounts.list answers AccountsOut: two Claude Code accounts in order, Codex its own, the others the CLI default', () => {
  const now = 1_700_000_000_000;
  const data = seed({ peer: 'local', now, extra: 0 });
  const ctx = { rows: (t: string) => data.topics.get(t as never) ?? [] } as unknown as CommandCtx;
  const list = (agent: string): { id: string; label: string; default: boolean; state: string }[] =>
    (COMMANDS['accounts.list']?.({ agent }, ctx).result as { accounts: { id: string; label: string; default: boolean; state: string }[] }).accounts;
  expect(list('claude').map((a) => [a.id, a.label, a.default, a.state])).toEqual([
    ['default', 'Personal', true, 'ready'],
    ['work', 'Work', false, 'limit'],
  ]);
  expect(list('codex').map((a) => [a.id, a.default])).toEqual([['default', true]]);
  expect(list('cursor').map((a) => [a.id, a.label])).toEqual([['default', 'Main']]);
  // AccountView's fields exactly (plugins/accounts/api/bindings/accounts/AccountView.ts): no row-only agent/ord
  expect(Object.keys(list('claude')[0] ?? {}).sort()).toEqual(['default', 'email', 'id', 'kind', 'label', 'plan', 'state', 'until', 'why']);
});

/** A ts-rs binding's top-level field names (`export type X = { a: …, b?: …, }`, doc comments between). */
function bindingFields(rel: string): string[] {
  const text = readFileSync(join(ROOT, rel), 'utf8').replace(/\/\*\*[\s\S]*?\*\//g, '');
  const body = /=\s*\{([\s\S]*)\}\s*;?\s*$/.exec(text)?.[1] ?? '';
  let depth = 0;
  let top = '';
  for (const ch of body) {
    if (ch === '{' || ch === '<' || ch === '[') depth++;
    else if (ch === '}' || ch === '>' || ch === ']') depth--;
    else if (depth === 0) top += ch;
  }
  return [...top.matchAll(/(?:^|,)\s*(\w+)\??\s*:/g)].map((m) => m[1] ?? '').sort();
}

test('the reads answer the fields of the ts-rs bindings: AccountsOut, AccountView, learn View and Lists, ShellStarted, Done', () => {
  const data = seed({ peer: 'local', now: 1_700_000_000_000, extra: 0 });
  const ctx = { rows: (t: string) => data.topics.get(t as never) ?? [] } as unknown as CommandCtx;
  const run = (cmd: string, args: unknown = {}): Record<string, unknown> => COMMANDS[cmd]?.(args, ctx).result as Record<string, unknown>;
  const keys = (o: unknown): string[] => Object.keys(o as object).sort();
  const B = 'plugins/%/api/bindings/%';
  const at = (plugin: string, file: string): string => B.replace('%', plugin).replace('%', `${plugin}/${file}.ts`);
  const out = run('accounts.list', { agent: 'claude' });
  expect(keys(out)).toEqual(bindingFields(at('accounts', 'AccountsOut')));
  for (const a of out['accounts'] as unknown[]) expect(keys(a)).toEqual(bindingFields(at('accounts', 'AccountView')));
  const view = run('learn.view');
  expect(keys(view)).toEqual(bindingFields(at('learn', 'View')));
  expect(keys(view['global'])).toEqual(bindingFields(at('learn', 'Lists')));
  // optional fields (`dir?`, `gone?`) may be left out
  const started = keys(run('terminal.shell.start', { id: 'local:s0000' }));
  expect(bindingFields(at('terminal', 'ShellStarted'))).toEqual(expect.arrayContaining(started));
  expect(started).toEqual(expect.arrayContaining(['ok', 'started']));
  expect(keys(run('terminal.input', { id: 'local:s0000', data: 'ls' }))).toEqual(bindingFields(at('terminal', 'Done')));
  // the row on the topic is AccountView plus the row's agent and ord (plugins/accounts/host/src/view.rs)
  const row = data.topics.get('plugin:wisp.accounts:harnesses' as never)?.find((r) => r.e === 'accounts.account');
  expect(keys(row?.v)).toEqual([...bindingFields(at('accounts', 'AccountView')), 'agent', 'ord'].sort());
});

test('All settings lists the declared settings with their owners and values (the kernel SettingInfo)', () => {
  const data = seed({ peer: 'local', now: 1_700_000_000_000, extra: 0 });
  const ctx = { rows: (t: string) => data.topics.get(t as never) ?? [] } as unknown as CommandCtx;
  const list = COMMANDS['settings.list']?.({}, ctx).result as { key: string; owner: string; decl: { key: string }; scope: string; value: unknown }[];
  expect(list.length).toBeGreaterThan(30);
  const panes = list.find((s) => s.key === 'stuff.panes');
  expect(panes).toMatchObject({ owner: 'wisp.stuff', scope: 'server', value: 'st2@home,st2@task', decl: { key: 'stuff.panes', type: 'string' } });
  expect(list.every((s) => s.key === s.decl.key)).toBe(true);
  // unset: its declared default, as the kernel answers (crates/wisp-kernel/src/settings.rs Inner::get)
  expect(list.find((s) => s.key === 'crew.tint')?.value).toBe(true);
});
