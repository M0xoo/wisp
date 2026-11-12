// The plugin's state that outlives a component, made once per plugin client (a WeakMap, not module
// state): its settings (the saved defaults v1 kept in config.defaults), the prompt history store,
// and the drafts it writes. Components get it with `envOf(client)`.

import type { Json, PluginClient, PluginStore, Readable, TypedSettings } from '@wisp/client';
import type { RunnerDefaults } from './model/runner.ts';
import { remember } from './text/history.ts';
import { DEFAULT_MODE, MODES, type Attachment, type EntityKey, type Mode, type Runner, type TeamMember } from './types.ts';

export const PLUGIN = 'wisp.shell-composer';

/** The plugin's settings keys (`<plugin>.<name>`, so they can only be this plugin's). */
export const SET = {
  followUp: 'shell-composer.followUp',
  mode: 'shell-composer.mode',
  runner: 'shell-composer.runner',
  worktree: 'shell-composer.worktree',
  team: 'shell-composer.team',
  readTimes: 'shell-composer.readTimes',
  project: 'shell-composer.project',
} as const;

const DECLS = [
  /** Queue switch: follow-ups wait for the run (queue) or interrupt it (now). One for every task. */
  { key: SET.followUp, type: 'enum', values: ['now', 'queue'], default: 'now' },
  /** New task's mode. */
  { key: SET.mode, type: 'enum', values: MODES, default: DEFAULT_MODE },
  /** the harness New task starts on, and each harness's model, thinking level and account */
  { key: SET.runner, type: 'json', default: null },
  { key: SET.worktree, type: 'bool', default: true },
  { key: SET.team, type: 'json', default: null },
  /** read "in 10 min …" at the start of a prompt as a time */
  { key: SET.readTimes, type: 'bool', default: true },
  /** the project New task is pointed at, on this device */
  { key: SET.project, type: 'string', default: '', scope: 'device' },
] as const;

export type ComposerSettings = TypedSettings<typeof DECLS>;

/** Per-draft fields (drafts store, keyed by the task or `<home>:launcher`). */
export const FIELD = { text: 'text', files: 'files', mode: 'mode', runner: 'runner' } as const;

export interface Env {
  readonly client: PluginClient;
  readonly settings: ComposerSettings;
  readonly sent: PluginStore<string[]>;
  readonly t: (key: string, vars?: Readonly<Record<string, string | number>>) => string;
  /** New task's draft entity */
  readonly launcherKey: EntityKey;
  text(entity: string): Readable<string>;
  setText(entity: string, value: string): void;
  files(entity: string): Readable<readonly Attachment[]>;
  setFiles(entity: string, files: readonly Attachment[]): void;
  /** the mode and runner picked for this task's next follow-up only */
  modeOverride(entity: string): Readable<Mode | undefined>;
  setModeOverride(entity: string, mode: Mode | undefined): void;
  runnerOverride(entity: string): Readable<Runner | undefined>;
  setRunnerOverride(entity: string, r: Runner | undefined): void;
  remember(text: string): void;
  defaults(): RunnerDefaults;
  team(): readonly TeamMember[];
}

const envs = new WeakMap<PluginClient, Env>();

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function make(client: PluginClient): Env {
  const settings = client.settings(DECLS);
  // a store id starts with the client's own name (`shell-composer.`), not the plugin id: `wisp.shell-composer.sent` was refused, and the env never built
  const sent = client.defineStore<string[]>({ id: `${client.id}.sent`, version: 1, defaults: [], check: (v) => (isStrings(v) ? v : undefined), persist: true });
  const d = client.drafts;
  const get = <T extends Json>(entity: string, field: string): Readable<T | undefined> => d.get<T>(entity, field);
  return {
    client,
    settings,
    sent,
    t: (key, vars) => client.t(key, vars),
    launcherKey: `${client.home}:launcher` as EntityKey,
    text: (entity) => {
      const r = get<string>(entity, FIELD.text);
      return () => r() ?? '';
    },
    setText: (entity, value) => d.set(entity, FIELD.text, value),
    files: (entity) => {
      const r = get<Attachment[] & Json>(entity, FIELD.files);
      return () => (r() as readonly Attachment[] | undefined) ?? [];
    },
    setFiles: (entity, files) => d.set(entity, FIELD.files, files.map((f) => ({ ...f })) as unknown as Json),
    modeOverride: (entity) => get<Mode>(entity, FIELD.mode) as Readable<Mode | undefined>,
    setModeOverride: (entity, mode) => d.set(entity, FIELD.mode, mode),
    runnerOverride: (entity) => get(entity, FIELD.runner) as Readable<Runner | undefined>,
    setRunnerOverride: (entity, r) => d.set(entity, FIELD.runner, r ? ({ ...r } as unknown as Json) : undefined),
    remember: (text) => sent.set((list) => [...remember(list, text)]),
    defaults: () => (settings.get(SET.runner)() ?? {}) as unknown as RunnerDefaults,
    team: () => (settings.get(SET.team)() ?? []) as unknown as readonly TeamMember[],
  };
}

export function envOf(client: PluginClient): Env {
  let e = envs.get(client);
  if (!e) envs.set(client, (e = make(client)));
  return e;
}
