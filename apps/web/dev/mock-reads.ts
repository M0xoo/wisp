// The reads the main screens send on open that mock-commands.ts didn't answer (each showed "the mock peer has no …" as
// an error toast in every screenshot): Home and every pane's runner picker (accounts.list), Settings → Memory, Usage,
// All settings, Sandboxes and Setup, and a task's Shell side. Shapes are the Rust ones: the ts-rs bindings where the
// api crate exports them (plugins/*/api/bindings: no TS package exports them, so test/mock-commands.test.ts checks the
// answers' fields against those files), else the api struct's fields as serde writes them (named below).
// What the UI defines but the mock leaves unanswered on purpose is in NOT_MOCKED, with why (test/mock-commands.test.ts).

import { readdirSync, readFileSync } from 'node:fs';
import type { EntityOp, Topic } from '@wisp/protocol';

interface Ctx {
  rows(topic: Topic): readonly { e: string; id: string; v: unknown }[];
}
type Fn = (args: unknown, ctx: Ctx) => { ops: EntityOp[]; result?: unknown };

export const HARNESSES_TOPIC = 'plugin:wisp.accounts:harnesses' as Topic;
const H = 3_600_000;

/** plugins/accounts/api/bindings/accounts/AccountView.ts */
interface AccountView {
  id: string;
  label: string;
  email: string;
  plan: string;
  default: boolean;
  kind: 'personal' | 'work';
  state: 'ready' | 'limit' | 'signedOut';
  until: number | null;
  why: string;
}
/** plugins/learn/api/bindings/learn/Lists.ts */
interface Lists {
  preferences: string[];
  lessons: string[];
  updatedAt: number;
}

/** wisp.accounts' `accounts.account` rows (plugins/accounts/host/src/view.rs: AccountView + id `<agent>/<id>`, agent,
 * ord): two accounts on Claude Code (the CLI's own, a work one at its 5-hour limit), Codex's own one. */
export function accountRows(now: number): { e: string; id: string; v: AccountView & { agent: string; ord: number } }[] {
  const rows: (AccountView & { agent: string })[] = [
    { agent: 'claude', id: 'default', label: 'Personal', email: 'sam@example.com', plan: 'Max', default: true, kind: 'personal', state: 'ready', until: null, why: '' },
    { agent: 'claude', id: 'work', label: 'Work', email: 'sam@acme.dev', plan: 'Team', default: false, kind: 'work', state: 'limit', until: now + 2 * H, why: '5-hour limit' },
    { agent: 'codex', id: 'default', label: 'Main', email: '', plan: '', default: true, kind: 'personal', state: 'ready', until: null, why: '' },
  ];
  return rows.map((a) => {
    const ord = rows.filter((r) => r.agent === a.agent).indexOf(a);
    return { e: 'accounts.account', id: `${a.agent}/${a.id}`, v: { ...a, id: `${a.agent}/${a.id}`, ord } };
  });
}

/** `accounts.list {agent}`: the harness's account rows in their order, as AccountView (the bare id); none saved: the
 * CLI's own one, "Main" (wisp-accounts-core accounts::raw). */
function accountsList(args: unknown, ctx: Ctx): { accounts: AccountView[] } {
  const agent = String((args as { agent?: unknown } | null)?.agent ?? '');
  const mine = ctx
    .rows(HARNESSES_TOPIC)
    .filter((r) => r.e === 'accounts.account' && (r.v as { agent?: string }).agent === agent)
    .map((r) => r.v as AccountView & { agent: string; ord: number })
    .sort((a, b) => a.ord - b.ord);
  if (!mine.length) return { accounts: [{ id: 'default', label: 'Main', email: '', plan: '', default: true, kind: 'personal', state: 'ready', until: null, why: '' }] };
  return { accounts: mine.map(({ agent: _a, ord: _o, ...v }) => ({ ...v, id: v.id.slice(v.id.indexOf('/') + 1) })) };
}

/** Settings → Memory (`learn.view`): what earlier retros kept, for every task and for the wisp repo. */
const LEARN: { global: Lists; projects: Record<string, Lists>; history: unknown[]; enabled: boolean } = {
  global: { preferences: ['Run only the test you are writing', 'Commit by file name, never git add -A'], lessons: ['Use a worktree: other sessions share the main checkout'], updatedAt: 0 },
  projects: { '~/code/wisp-repo': { preferences: ['Every user-facing string goes through t()'], lessons: [], updatedAt: 0 } },
  history: [],
  enabled: true,
};

interface Decl {
  key: string;
  type: string;
  values?: string[];
  default?: unknown;
  title?: string;
  scope?: string;
  secret?: boolean;
}
interface Manifest {
  id: string;
  contributes?: { settings?: Decl[] };
}

/** The plugins' manifests (each plugin's host/wisp-plugin.json), read once when All settings first asks (the mock runs in
 * vite's node process); unreadable: none. */
let manifests: Manifest[] | undefined;
function readManifests(): Manifest[] {
  if (manifests) return manifests;
  const root = new URL('../../../plugins/', import.meta.url);
  try {
    manifests = readdirSync(root).flatMap((p) => {
      try {
        return [JSON.parse(readFileSync(new URL(`${p}/host/wisp-plugin.json`, root), 'utf8')) as Manifest];
      } catch {
        return [];
      }
    });
  } catch {
    manifests = [];
  }
  return manifests;
}

/** Settings → All settings (`settings.list`): the kernel's SettingInfo (crates/wisp-kernel/src/settings.rs: key, owner,
 * decl, scope, value) for every setting the plugins' manifests declare, with the mock's `setting` rows as values. */
function settingsList(ctx: Ctx): unknown[] {
  const set = new Map(ctx.rows('config').filter((r) => r.e === 'setting').map((r) => [r.id, (r.v as { value?: unknown }).value]));
  return readManifests().flatMap((m) =>
    // unset: the declared default (the kernel's Inner::get); scope `device` only when declared so
    (m.contributes?.settings ?? []).map((decl) => ({
      key: decl.key,
      owner: m.id,
      decl,
      scope: decl.scope === 'device' ? 'device' : 'server',
      value: set.has(decl.key) ? set.get(decl.key) : (decl.default ?? null),
    })),
  );
}

/** Settings → Setup (`resources.kinds`): resources-api KindInfo as serde writes it (no rename: snake_case; `aliases`
 * left out when empty), for some of the kinds the plugins register (their `KindInfo::new(…)` order, scope, flags). */
const kind = (k: string, section: string, owner: string, order: number, o: { scope?: string; mapForm?: boolean; singleton?: boolean; sensitive?: boolean } = {}) => ({
  kind: k,
  section,
  owner,
  scope: o.scope ?? 'shared',
  sensitive: o.sensitive ?? false,
  order,
  map_form: o.mapForm ?? false,
  singleton: o.singleton ?? false,
  claims_settings: false,
  schema: { type: 'object' },
  doc: '',
});
const KINDS = [
  kind('setting', 'settings', 'wisp.settings', 5, { mapForm: true }),
  kind('ui', 'ui', 'wisp.settings', 6, { scope: 'device', singleton: true }),
  kind('project', 'projects', 'wisp.runtime', 10),
  kind('account', 'accounts', 'wisp.accounts', 14, { scope: 'personal' }),
  kind('agent', 'agents', 'wisp.runtime', 20),
  kind('crew', 'crew', 'wisp.crew', 60),
  kind('task', 'tasks', 'wisp.automations', 80, { sensitive: true }),
];

export const READS: Record<string, Fn> = {
  'accounts.list': (a, ctx) => ({ ops: [], result: accountsList(a, ctx) }),
  'learn.view': () => ({ ops: [], result: LEARN }),
  // tokens per turn by account: only models two accounts ran enough turns on; the mock's turns name no account
  'budget.compare': () => ({ ops: [], result: [] }),
  'settings.list': (_a, ctx) => ({ ops: [], result: settingsList(ctx) }),
  // sandbox-api Info (enabled, why, logins, env, sandboxes): this computer isn't signed in to a grid that makes them
  'sandbox.info': () => ({ ops: [], result: { enabled: false, why: 'Sign in to a wisp Grid that makes sandboxes', logins: [], env: [], sandboxes: [] } }),
  'resources.kinds': () => ({ ops: [], result: KINDS }),
  // the task's shell starts (no pty behind it: nothing it types comes back)
  'terminal.shell.start': () => ({ ops: [], result: { ok: true, started: true, dir: '~/code/wisp-repo' } }),
  'terminal.input': () => ({ ops: [], result: { ok: true } }),
};

const ACTION = 'sent only by a click (not on open): unanswered, its refusal toast and rollback are what a check of that control wants';
const reason = (why: string, ids: readonly string[]): [string, string][] => ids.map((id) => [id, why]);

/** Commands the UI defines that the mock refuses on purpose, each with why. Add a command to COMMANDS or here. */
export const NOT_MOCKED: Readonly<Record<string, string>> = Object.fromEntries([
  ...reason('a sign-in or key flow: needs the harness CLI or a provider to answer', [
    'accounts.add', 'accounts.keys.remove', 'accounts.keys.set', 'accounts.keys.test', 'accounts.login.cancel', 'accounts.login.input',
    'accounts.login.start', 'accounts.logout', 'accounts.remove', 'accounts.update', 'accounts.watch.ask', 'accounts.watch.trust',
    'runtime.signIn', 'connectors.signin', 'connectors.signout',
  ]),
  ...reason('wisp Grid / cloud: needs a signed-in grid (the mock has none)', [
    'grid-client.computer', 'grid-client.revoke', 'grid-client.shares', 'grid-client.signin', 'grid-client.signinCancel', 'grid-client.signout',
    'sandbox.claude.begin', 'sandbox.claude.code', 'sandbox.drop', 'sandbox.env', 'sandbox.launch', 'sandbox.logout',
    'share.create', 'share.import', 'share.peek', 'share.preview', 'share.stop', 'stuff.publish', 'stuff.unpublish', 'crew.share',
  ]),
  ...reason('another computer: the mock has one peer (?seed=computers adds a read-only Studio)', [
    'machines.add', 'machines.connect', 'machines.disconnect', 'machines.discover', 'machines.letIn', 'machines.list', 'machines.remove',
    'machines.stop', 'machines.update',
  ]),
  ...reason('GitHub: needs gh and a real PR', ['ship.check_log', 'ship.details', 'ship.fix_conflicts', 'ship.merge', 'ship.refresh', 'ship.ship', 'ship.view', 'review.maybe', 'git.clone']),
  ...reason('a real repo, language server or pty on disk: the mock git (mock-git.ts) has no files to read', [
    'history.blame', 'history.list', 'history.report', 'lsp.ask', 'worktrees.files', 'worktrees.grep', 'worktrees.save', 'worktrees.source',
    'runtime.terminal', 'runtime.exec', 'git.restoreTurn',
  ]),
  ...reason('updates: needs the release feed', ['update.check', 'update.install']),
  ...reason(ACTION, [
    'automations.sources', 'automations.task.remove', 'automations.task.set', 'automations.trigger.fire', 'automations.trigger.test',
    'budget.dismissDrain', 'budget.dismissNotice', 'budget.setStop',
    'connectors.add', 'connectors.import', 'connectors.remove', 'connectors.test', 'connectors.update',
    'crew.adopt', 'crew.ask', 'crew.assign', 'crew.checkin', 'crew.create', 'crew.detach', 'crew.import', 'crew.remove', 'crew.reply',
    'goal.check', 'goal.drop', 'goal.pause', 'goal.resume',
    'later.cancelPlan', 'later.editPlan', 'later.park', 'learn.set',
    'machine.automations.pause', 'machine.fix', 'machine.harness.clean', 'machine.stop',
    'plugins.install', 'plugins.setEnabled', 'plugins.uninstall',
    'resources.plan', 'resources.read', 'resources.rename', 'resources.write', 'router.reset',
    'runtime.answer', 'runtime.appState', 'runtime.approveBlocked', 'runtime.compact', 'runtime.held', 'runtime.projectTest', 'runtime.release',
    'runtime.resumeCommand', 'runtime.setExt', 'runtime.setLean', 'runtime.turns', 'runtime.unmasked',
    'stuff.remove', 'stuff.resetData', 'stuff.restore', 'stuff.reveal', 'stuff.save', 'stuff.stop', 'stuff.update', 'telemetry.set',
    'worktrees.bringIn', 'worktrees.dismiss', 'worktrees.done.apply', 'worktrees.done.list', 'worktrees.keep',
  ]),
]);
