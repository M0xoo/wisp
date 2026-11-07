// @wisp/shell's contract: how a plugin's UI plugs into the app (plan §6.6, ADR-0003, ADR-0007).
// The shell is an extension tree. Every slot is a typed *input* of a parent extension; plugins attach
// extensions to inputs, override an extension by id, disable one, or set its config. Built-in screens
// use exactly this API (no private API for first-party code, plan §6.0.3).

import type { Component, JSX } from 'solid-js';
import type { Client, PluginClient, Nav, Intent } from '@wisp/client';
import type { Toaster } from '@wisp/ui';
import type { Platform } from './platform/types.ts';

/** Inputs the shell's own extensions offer. v1 spell SLOTS map 1:1 (`feed.top` → `shell.list:top`). */
export const INPUTS = {
  // top bar
  'shell.topbar:brand': 'topbar.brand',
  'shell.topbar:projects': 'topbar.projects',
  'shell.topbar:machines': 'topbar.machines',
  'shell.topbar:getapp': 'topbar.getapp',
  'shell.topbar:automations': 'topbar.automations',
  'shell.topbar:search': 'topbar.search',
  'shell.topbar:account': 'topbar.account',
  'shell.topbar:settings': 'topbar.settings',
  'shell.topbar:view': 'topbar.view',
  'shell.account:menu': 'account.menu',
  // the task list (sidebar)
  'shell.list:top': 'sidebar.top',
  'shell.list:feedTop': 'feed.top',
  'shell.list:needs': 'section.needs',
  'shell.list:working': 'section.working',
  'shell.list:scheduled': 'section.scheduled',
  'shell.list:scheduledRow': 'scheduled.row',
  'shell.list:drafts': 'section.drafts',
  'shell.row:head': 'card.head',
  'shell.row:hover': 'card.hover',
  'shell.row:menu': 'card.menu',
  'shell.row:top': 'card.top',
  'shell.row:bottom': 'card.bottom',
  // the open task
  'shell.task:head': 'split.head',
  'shell.task:details': 'split.details',
  'shell.task:panes': 'split.panes',
  'shell.task:upcoming': 'split.upcoming',
  'shell.task:band': 'goal.band',
  'shell.side:head': 'panel.head',
  'shell.term:head': 'term.head',
  // composer and new task
  'shell.composer:bar': 'composer.bar',
  'shell.composer:chips': 'composer.chips',
  'shell.launcher:bar': 'launcher.bar',
  'shell.launcher:chips': 'launcher.chips',
  // other screens
  'shell.crew:page': 'crew.page',
  'shell.crew:rail': 'crew.rail',
  'shell.org:head': 'org.head',
  'shell.plan:head': 'plan.head',
  'shell.plan:page': 'plan.page',
  'shell.plan:prompt': 'plan.prompt',
  'shell.plan:details': 'plan.details',
  'shell.plan:actions': 'plan.actions',
  'shell.stuff:head': 'stuff.head',
  'shell.machine:head': 'machine.head',
  'shell.getapp:card': 'getapp.card',
  'shell.palette:tags': 'palette.tags',
  'shell.switcher:row': 'switcher.row',
  // whole areas a plugin may override by id (Backstage overrides)
  'shell.app:main': null,
  'shell.app:side': null,
  'shell.app:overlay': null,
  'shell.settings:pane': null,
  'shell.block:renderer': null,
  // added 2026-11-08 (additive): the areas the frame renders, each one extension (the last
  // registered, or an override) — shell-list fills the list, shell-home/shell-task the screens
  'shell.sidebar:list': null,
  'shell.screen:home': null,
  'shell.screen:task': null,
  'shell.screen:crew': null,
  'shell.side:changes': null,
  'shell.side:shell': null,
  'shell.side:pr': null,
} as const satisfies Record<string, string | null>;

export type InputId = keyof typeof INPUTS;

/** What an extension's component receives. `session` is set inside task-scoped inputs (row, task, composer). */
export interface ExtensionProps<C = Record<string, unknown>> {
  client: PluginClient;
  config: C;
  session?: () => { id: string; agent: string; [k: string]: unknown } | undefined;
  /** added: inside a bar input, the form the Toolbar gives the item ('full' = icon and label) */
  form?: 'full' | 'icon';
  /** added: on a screen or side input, the entity it shows (a task's key, a crew member's id) */
  id?: string;
}

export interface ExtensionDef<C = Record<string, unknown>> {
  id: string; // owner-prefixed: 'claude.model-picker'
  attachTo: { id: InputId | (string & {}); input?: string };
  /** lazy(() => import('./X.tsx')): a plugin's code loads on first show */
  component: Component<ExtensionProps<C>>;
  /** collapsed form in a bar (design/layout.md §2): required for anything attached to a bar input */
  bar?: {
    icon: string;
    label: string;
    priority: number | 'pin';
    /** added: what choosing it from the bar's More menu does (default: nothing) */
    select?: (p: ExtensionProps<C>) => void;
  };
  config?: { parse(v: unknown): C; default: C };
  if?: (p: ExtensionProps<C>) => boolean;
  /** an override replaces the extension with this id */
  overrides?: string;
  order?: number;
}

/** A view kind a plugin registers for navigation (`main` or `side`), with typed params (plan §4.6.4). */
export interface ViewDef<P = unknown> {
  kind: string; // 'crew.member'
  slot: 'main' | 'side' | 'overlay';
  parse(params: unknown): P;
  component: Component<{ client: PluginClient; params: P }>;
  title?(params: P): string;
  /** added: an overlay view's presentation (default 'dialog'; a sheet on phones either way) */
  overlay?: 'viewer' | 'dialog' | 'sheet';
}

/** A Settings pane. */
export interface SettingsPaneDef {
  id: string;
  group: 'general' | 'agents' | 'usage' | 'integrations' | 'computers' | 'advanced' | (string & {});
  title: string; // i18n key
  icon: string;
  component: Component<{ client: PluginClient }>;
  order?: number;
}

/** An answer block renderer (the `runtime.block` point's UI half). */
export interface BlockRendererDef {
  type: string;
  component: Component<{ block: Record<string, unknown>; client: PluginClient; sessionId: string }>;
}

export interface PluginUiDef {
  id: string; // the plugin id: 'wisp.crew'
  /** built with defineExtension(), which erases C after checking it */
  extensions?: ExtensionDef[];
  /** built with defineView(), which erases P after checking it */
  views?: ViewDef[];
  settings?: SettingsPaneDef[];
  blocks?: BlockRendererDef[];
  /** commands this UI declares (defineCommand from @wisp/client) */
  commands?: unknown[];
  /** i18n catalogue: key → English */
  catalogue?: Record<string, string>;
  /** runs once when the plugin's UI activates; everything registered belongs to its scope */
  setup?(client: PluginClient): void;
  /** added: how this plugin configures the tree (a spell's PART_PROPS, moves, removals) */
  tree?: TreeConfig;
  /** added: what it adds to the command palette (⌘K) */
  palette?: PaletteSourceDef[];
  /** added: its keyboard shortcuts (only keys the shell doesn't use itself, see BUILT_IN_KEYS) */
  shortcuts?: ShortcutDef[];
}

export interface ShellApi {
  client: Client;
  nav: () => Nav;
  register(def: PluginUiDef): void;
  render(root: HTMLElement): () => void;
  // added 2026-11-08 (additive)
  /** what the screens read through useShell() */
  readonly context: ShellContext;
  /** register returns nothing (frozen); this switches a plugin's UI off again: its scope ends */
  unregister(id: string): void;
  dispose(): void;
}

// ---------- added 2026-11-08 (additive): tree config, palette, shortcuts, the shell context ----------

/** A plugin's say over other extensions. Later plugins win over earlier ones, key by key. */
export interface TreeConfig {
  /** extensions (by id) that no longer show */
  disable?: string[];
  /** an extension's config, checked by its own `config.parse` (a bad value keeps the default) */
  config?: Record<string, unknown>;
  /** moves an extension to another input */
  attach?: Record<string, ExtensionDef['attachTo']>;
  /** an extension's place among its siblings (lower first) */
  order?: Record<string, number>;
}

/** An extension as the shell resolved it: where it sits, its parsed config, its place. */
export interface ResolvedExtension {
  readonly id: string;
  readonly plugin: string;
  readonly def: ExtensionDef;
  readonly config: Record<string, unknown>;
  readonly order: number;
}

/** One row of the command palette (v1 web/js/palette.js items). */
export interface PaletteItem {
  id: string;
  /** an i18n key or already-translated text: the group heading ("This task", "Go to") */
  group: string;
  label: string;
  sub?: string;
  icon?: string;
  /** the shortcut hint shown on the row ('E', '⇧R') */
  kbd?: string;
  /** extra words it matches */
  keywords?: string;
  /** topic words: "#auth" in the query keeps only items tagged auth */
  tags?: readonly string[];
  /** ms: when it was last touched; recent items rank higher */
  at?: number;
  /** a fixed rank inside its group (lower first) when the query is empty */
  rank?: number;
  /** choosing it types this into the input instead of running anything */
  fill?: string;
  run?(): void;
}

export interface PaletteContext {
  client: PluginClient;
  nav: Nav;
  /** the task the keyboard is on (or the open one) */
  focused: string | undefined;
}

export interface PaletteSourceDef {
  id: string;
  /** with an empty query, sources show in this order (lower first) */
  order?: number;
  items(ctx: PaletteContext): readonly PaletteItem[];
  /** more items for a query from the peer (past work by its words); they follow the rest */
  deep?(query: string, ctx: PaletteContext, signal: AbortSignal): Promise<readonly PaletteItem[]>;
}

/** 'e', 'shift+r', 'mod+k' (⌘ on a Mac, Ctrl elsewhere), 'ctrl+`', 'escape', '?' */
export type KeyCombo = string;

export interface ShortcutContext {
  client: PluginClient;
  nav: Nav;
  focused: string | undefined;
  event: KeyboardEvent;
}

export interface ShortcutDef {
  id: string;
  keys: KeyCombo;
  /** i18n key: the row in the shortcuts sheet (?) */
  label: string;
  group?: 'general' | 'task' | 'list' | (string & {});
  /** 'idle' (default): not while typing or with an overlay up · 'always': even mid-sentence ·
   * 'task': idle, and a task is focused */
  when?: 'idle' | 'always' | 'task';
  /** false: not handled, the key goes on */
  run(ctx: ShortcutContext): boolean | void;
}

export type ThemePref = 'system' | 'light' | 'dark';

/** What every screen reads through useShell(): the shell's own state and services. */
export interface ShellContext {
  readonly client: Client;
  readonly nav: () => Nav;
  navigate(intent: Intent): void;
  /** t('key', vars): every user-facing string */
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  readonly toast: Toaster;
  readonly platform: Platform;
  readonly theme: { pref(): ThemePref; resolved(): 'light' | 'dark'; set(pref: ThemePref): Promise<void> };
  /** the task the keyboard is on (j/k, a row's focus): UI state the list and the keys share */
  readonly selection: { get(): string | undefined; set(key: string | undefined): void };
  /** the list beside the task (split view): `[` folds it */
  readonly sidebar: { open(): boolean; toggle(): void; width(): number; setWidth(px: number): void };
  /** named things a shortcut can focus ('launcher' for ⌘L, 'reply' for /): the owner registers */
  readonly focusTargets: { provide(name: string, focus: () => void): () => void; focus(name: string): boolean };
  readonly palette: { open(query?: string): void };
  /** the extensions on one input, resolved (overrides, disable, attach, config, order) */
  extensions(input: string): () => readonly ResolvedExtension[];
  settingsPanes(): () => readonly SettingsPaneDef[];
  block(type: string): BlockRendererDef | undefined;
  view(kind: string): ViewDef | undefined;
}

export type { JSX };
