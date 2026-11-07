// @wisp/shell's contract: how a plugin's UI plugs into the app (plan §6.6, ADR-0003, ADR-0007).
// The shell is an extension tree. Every slot is a typed *input* of a parent extension; plugins attach
// extensions to inputs, override an extension by id, disable one, or set its config. Built-in screens
// use exactly this API (no private API for first-party code, plan §6.0.3).

import type { Component, JSX } from 'solid-js';
import type { Client, PluginClient, Nav } from '@wisp/client';

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
} as const satisfies Record<string, string | null>;

export type InputId = keyof typeof INPUTS;

/** What an extension's component receives. `session` is set inside task-scoped inputs (row, task, composer). */
export interface ExtensionProps<C = Record<string, unknown>> {
  client: PluginClient;
  config: C;
  session?: () => { id: string; agent: string; [k: string]: unknown } | undefined;
}

export interface ExtensionDef<C = Record<string, unknown>> {
  id: string; // owner-prefixed: 'claude.model-picker'
  attachTo: { id: InputId | (string & {}); input?: string };
  /** lazy(() => import('./X.tsx')): a plugin's code loads on first show */
  component: Component<ExtensionProps<C>>;
  /** collapsed form in a bar (design/layout.md §2): required for anything attached to a bar input */
  bar?: { icon: string; label: string; priority: number | 'pin' };
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
}

export interface ShellApi {
  client: Client;
  nav: () => Nav;
  register(def: PluginUiDef): void;
  render(root: HTMLElement): () => void;
}

export type { JSX };
