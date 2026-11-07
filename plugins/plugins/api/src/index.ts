// @wisp-plugin/plugins-api: the contract of wisp.plugins, the plugin manager (Settings → Plugins, ex
// "spells"). It lists, installs, switches on and off and removes the user's plugins: folders with a
// wisp-plugin.json in ~/.wisp/plugins, and v1 wispSpell files in ~/.wisp/spells, which are converted
// to manifests (@wisp/kernel convertSpell) and still load for two releases.
//
// Switching a plugin on or off at runtime is the kernel's job: wisp.plugins asks it through the
// PLUGIN_HOST service, which apps/server provides over the kernel's loader.

import type { Json, Manifest, PluginStatus, ServiceRef } from '@wisp/kernel';

// ---------- the kernel's plugin host (provided by apps/server) ----------

/**
 * The running set of plugins, as the kernel sees it. Every result is plain data. `install` registers
 * (or replaces, same id) a user plugin from its manifest; it stays off until `enable`. `root` is the
 * folder its code and relative paths resolve from; a declarative plugin (a converted spell) has none.
 */
export interface PluginHost {
  /** every plugin the kernel knows, built-in or not, with its state */
  list(): PluginStatus[];
  manifest(id: string): Manifest | undefined;
  install(manifest: Manifest, root?: string): Promise<PluginStatus>;
  /** refused (`conflict`) with the reason when a requirement is off or missing */
  enable(id: string): Promise<PluginStatus>;
  /** refused (`conflict`) with the dependents' names when others require it */
  disable(id: string): Promise<PluginStatus>;
  /** forgets a user plugin (switching it off first); a built-in is refused */
  remove(id: string): Promise<void>;
}

export const PLUGIN_HOST: ServiceRef<PluginHost> = {
  id: 'kernel.plugins',
  major: 1,
  permissions: {
    list: 'plugins:read',
    manifest: 'plugins:read',
    install: 'plugins:install',
    enable: 'plugins:write',
    disable: 'plugins:write',
    remove: 'plugins:install',
  },
  readOnly: ['list', 'manifest'],
};

// ---------- rows ----------

export type Kind = 'spell' | 'plugin';
/** the riskiest thing a plugin can do: safe < acts < reads < runs */
export type Risk = 'safe' | 'acts' | 'reads' | 'runs';

/** Where an installed plugin came from (v1 spells.json `sources`). */
export interface Source {
  kind: 'local' | 'file' | 'url' | 'gist' | 'folder' | (string & {});
  url?: string;
  owner?: string;
  name?: string;
  session?: string;
  at: number;
}

/** One row of `plugins_state`: what v1 kept in ~/.wisp/spells.json, per plugin. */
export interface StateRow {
  [k: string]: unknown;
  /** the spell id for a spell ('my-prs'), the manifest id for a folder plugin ('acme.thing') */
  id: string;
  kind: Kind;
  enabled: boolean;
  source: Source | null;
  at: number;
}

/** A v1 spell as GET /api/spells answers it: the spell, plus on/off, source, hash and what it does. */
export interface SpellView {
  [k: string]: unknown;
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  source: Source | null;
  hash: string;
  summary: string[];
  kind: Risk;
}

/** A row of Settings → Plugins. */
export interface PluginView {
  /** the plugin id the kernel knows it by ('user.my-prs' for a spell) */
  id: string;
  name: string;
  version: string;
  description: string;
  kind: Kind;
  enabled: boolean;
  builtin: boolean;
  source: Source | null;
  /** what it does, in plain words */
  summary: string[];
  risk: Risk;
  /** the kernel's state: 'active', 'off', 'refused' (with reason), or 'unknown' without a kernel host */
  state: PluginStatus['state'] | 'unknown';
  reason?: string;
  trust: 'declarative' | 'untrusted' | 'trusted';
}

export interface Broken {
  id: string;
  error: string;
}

export interface CheckOk {
  ok: true;
  spell: Record<string, unknown>;
  summary: string[];
  kind: Risk;
  warnings: string[];
  installed: { version: string; enabled: boolean; same: boolean } | null;
}
export interface CheckBad {
  ok: false;
  problems: string[];
  error: string;
}

// ---------- commands (permissions: plugins:read, plugins:install, plugins:write, plugins:open, plugins:make) ----------

export const COMMANDS = {
  list: 'plugins.list', // {} → { safe, plugins: PluginView[], spells: SpellView[], broken: Broken[] }  (read)
  get: 'plugins.get', // { id } → PluginView | SpellView  (read)
  check: 'plugins.check', // { spell } | { plugin } | { text } | { url } → CheckOk | CheckBad  (read)
  install: 'plugins.install', // { spell | plugin | text | url | dir, enable?, source? } → { spell?, plugin?, warnings, updated }  (install)
  setEnabled: 'plugins.setEnabled', // { id, enabled } → SpellView | PluginView  (write)
  allOff: 'plugins.allOff', // {} → list  (write: the way out when one makes the page unusable)
  remove: 'plugins.remove', // { id, crew?: 'keep' | 'remove' } → { ok }  (install)
  export: 'plugins.export', // { id } → the file to share  (read)
  data: 'plugins.data', // { id, name, session?, fresh? } → { value }  (read: a data source, fetched for it)
  tryData: 'plugins.tryData', // { spell, name, session? } → { value }  (read)
  open: 'plugins.open', // { urls } → { opened }  (open: links in the default browser)
  reference: 'plugins.reference', // {} → the full spell reference (wisp_spell_schema)  (read)
  guide: 'plugins.guide', // { tool? } → { text }: the Make a plugin agent's guide  (read)
  locks: 'plugins.locks', // {} → { values, lockedBy }: settings plugins that are on set  (read)
  recipes: 'plugins.recipes', // {} → recipes of the plugins that are on  (read)
  make: 'plugins.make', // { prompt, agent?, model?, effort? } → { id }: start a Make a plugin task  (make)
} as const;

// ---------- events (after commit) ----------

export const EVENTS = {
  changed: 'plugins.changed', // { enabled: string[] }  (spell ids and plugin ids that are on)
  installed: 'plugins.installed', // { id, source, enabled, kind: Risk }  (telemetry: v1 spell_installed)
  removed: 'plugins.removed', // { id, crew?: 'keep' | 'remove' }  (wisp.crew lets the spell's members go, or keeps them as yours)
  hook: 'plugins.hook', // { on, action, plugin }  (telemetry: v1 spell_hook)
  toast: 'plugins.toast', // { toast, plugin, session }  (a hook's notify, for the open pages)
} as const;

// ---------- extension points ----------

/**
 * `plugins.vocabulary@1`: names a spell (or a declarative plugin) may use, contributed by whoever
 * owns them: the shell its slots and data-parts, a settings owner the settings a plugin may set.
 * Contributions are merged with the v1 names wisp.plugins ships for the compat path.
 */
export interface Vocabulary {
  slots?: Readonly<Record<string, string>>;
  parts?: readonly string[];
  partProps?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;
  tokens?: readonly string[];
  icons?: readonly string[];
  /** setting → its allowed values, or 'string' */
  settings?: Readonly<Record<string, readonly string[] | 'string'>>;
}

/**
 * `plugins.section@1`: a section of a spell another plugin owns and checks, such as `crew` (its
 * blueprints, wisp.crew). `check` throws an Error whose message is the problem; `describe` says in
 * plain words what one entry does, and how risky it is.
 */
export interface Section {
  key: string;
  max: number;
  check(value: readonly unknown[], where: string): Json[];
  describe?(entry: Json): { line: string; risk: Risk };
}

export const POINTS = {
  vocabulary: 'plugins.vocabulary',
  section: 'plugins.section',
} as const;

/** Rows are published on the kernel's config topic, beside the kernel's own plugin rows. */
export const TOPIC = 'config';
/** The ext slot a Make a plugin task carries: `session.ext['wisp.plugins'] = { make: true }`. */
export const EXT = 'wisp.plugins';
