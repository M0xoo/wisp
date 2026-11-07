// @wisp-plugin/settings-api: the contract of wisp.settings, the plugin behind v1's Settings page API
// (server/routes/settings.js): GET/PATCH /api/config and the projects list. It owns no feature
// setting: each plugin declares its own in its manifest (`contributes.settings`), and the kernel's
// settings registry holds them. wisp.settings shows them to v1 clients under their v1 names, and owns
// the few preferences no other plugin reads (theme, editor, notify, readTimes) and the projects.
//
// v1 names: a setting `<prefix>.<name>` of the plugin whose ids start with `<prefix>` is
// `config.defaults.<name>` on the wire ('update.updateChannel' → updateChannel); a setting named the
// prefix itself keeps it ('telemetry' → telemetry). The v1 importer maps config.json the same way.

import type { Caller, Json, ServiceRef } from '@wisp/kernel';

export const SETTINGS_ID = 'wisp.settings';

/** The v1 name of a setting key declared by `owner` (see the header). */
export function v1Name(key: string, owner: string): string {
  const prefix = owner.slice(owner.indexOf('.') + 1);
  if (key.startsWith(`${owner}.`)) return key.slice(owner.length + 1);
  if (key.startsWith(`${prefix}.`)) return key.slice(prefix.length + 1);
  return key;
}

// ---------- projects (v1 config.projects) ----------

/** A project is one repo, and every place can run it (v1 store.js). */
export interface Project {
  id: string;
  name: string;
  /** where it was added, on `machine` (absent: this computer) */
  path: string;
  color: string;
  addedAt: number;
  machine?: string;
  /** its origin URL, once known */
  repo?: string;
  /** its checkouts elsewhere: { [machine id, or 'here']: path } */
  copies?: Record<string, string>;
  /** Auto's test check: the command, '' to detect it, 'off' for none */
  testCommand?: string;
  lastUsedAt?: number;
  /** fields another plugin keeps on a v1 project, carried over as they were */
  [field: string]: Json | undefined;
}

export const HERE = 'here';
export const PROJECT_COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'] as const;

/** The project's folder on `machine` (null = this computer), or null when it has none there yet. */
export function pathAt(p: Pick<Project, 'machine' | 'path' | 'copies'>, machine: string | null = null): string | null {
  return (p.machine || null) === (machine || null) ? p.path : (p.copies?.[machine || HERE] ?? null);
}

// ---------- commands ----------

/**
 * Every write to the server's settings is one command, `settings.write`, so one permission guards
 * them: `settings:write{scope:server}`, which `agent:session` denies ("change wisp's settings").
 */
export type WriteArgs =
  | { op: 'defaults'; defaults: Record<string, Json>; viaTunnel?: boolean }
  | { op: 'project.add'; path: string; name?: string; color?: string; machine?: string; repo?: string }
  | { op: 'project.edit'; id: string; name?: string; color?: string; testCommand?: string }
  | { op: 'project.copy'; id: string; machine: string | null; path: string }
  | { op: 'project.touch'; path: string }
  | { op: 'project.remove'; id: string };

export const COMMANDS = {
  write: 'settings.write', // WriteArgs → { ok: true } | Project
} as const;

// ---------- interceptor hooks ----------

/** `before:settings`: a plugin refuses a change to its own settings (a veto's code `invalid` answers 400, others 403). */
export interface BeforeSettingsCtx {
  /** v1 name → the new value (null: back to the default) */
  changes: Record<string, Json>;
  /** v1 name → the registry key */
  keys: Record<string, string>;
  /** the request came through the grid tunnel (v1 fromTunnel): a phone, or anything else outside */
  viaTunnel: boolean;
  caller: Caller;
}

export const HOOKS = {
  beforeWrite: 'before:settings',
} as const;

// ---------- extension point: settings.config@1 ----------

/**
 * What a plugin adds to v1's GET /api/config, and the top-level PATCH keys it takes. v1 sent its
 * whole config.json there (crew, triggers, recipes, teams, machines, connectors, webhooks) plus facts
 * about this wisp (terminals, cloneDir, grid, preview, spells…): each now comes from its owner.
 */
export interface ConfigPart {
  plugin: string;
  /** top-level fields, v1 names */
  read(): Record<string, Json> | Promise<Record<string, Json>>;
  /** top-level PATCH /api/config keys this plugin applies (v1: webhooks → wisp.automations) */
  patchKeys?: readonly string[];
  /** applies them through its own command; throws an `invalid` error (400) to refuse */
  patch?(body: Record<string, Json>, caller: Caller): Promise<void>;
}

export const POINTS = {
  config: 'settings.config',
} as const;

// ---------- service: settings.projects@1 ----------

/** The projects, for the plugins that match a task to its project (runtime's list rows, places, …). */
export interface ProjectsService {
  list(): Project[];
  get(id: string): Project | null;
  /** the project a folder is in: the longest match (machine: a folder on that computer) */
  projectFor(cwd: string, machine?: string | null): Project | null;
}

export const PROJECTS = {
  id: 'settings.projects',
  major: 1,
  permissions: { list: 'settings:read', get: 'settings:read', projectFor: 'settings:read' },
  readOnly: ['list', 'get', 'projectFor'],
} as const satisfies ServiceRef<ProjectsService>;

export const TOPIC = 'config';
