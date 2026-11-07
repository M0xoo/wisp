// What wisp.grid-client needs from plugins whose api packages don't declare it yet (My Stuff and its
// bundles, the app scan, uploads, the secret scan, crew blueprints, the runtime's import of a shared
// task). Narrow structural contracts with the service and command ids this plugin expects: each owner
// provides them (or moves them into its own api, and this file re-exports them from there).
// Only plain data crosses a service boundary, so bundles travel as files, never as Buffers.

import type { Json, ServiceRef } from '@wisp/kernel';

// ---------- My Stuff (owner: wisp.stuff, v1 services/stuff.js) ----------

export interface StuffItemView {
  id: string;
  kind: string;
  title: string;
  name: string;
  path: string;
  entry?: string;
  rev?: number;
  size?: number;
  files?: number;
  excerpt?: string;
  url?: string;
  cover?: string;
  published?: Json;
  [field: string]: Json | undefined;
}

export interface StuffPort {
  get(id: string): StuffItemView | null;
  /** keeps where it is published (null: not any more); returns the item as the page shows it */
  setPublished(id: string, published: Json): StuffItemView;
  /** the item an import made before, by its key (`share:<id>:<pack>`) */
  findKey(key: string): StuffItemView | null;
  addLink(url: string, o: { title: string; by: string; from: Json }): StuffItemView;
  addApp(dir: string, o: { title: string; by: string; from: Json; cover?: string }): StuffItemView;
  addFile(file: string, o: { title: string; by: string; from: Json; name: string }): StuffItemView;
}
export const STUFF_PORT: ServiceRef<StuffPort> = {
  id: 'stuff.items',
  major: 1,
  permissions: { get: 'stuff:read', setPublished: 'stuff:publish', findKey: 'stuff:read', addLink: 'stuff:save', addApp: 'stuff:save', addFile: 'stuff:save' },
  readOnly: ['get', 'findKey'],
};

// ---------- bundles and the app scan (owner: wisp.stuff, v1 bundle.js and app-scan.js) ----------

export interface Packed {
  /** the bundle, written to a file the caller removes */
  file: string;
  files: number;
  bytes: number;
}
export interface BundlePort {
  /** packs `dir`; skip 'private' leaves out what privateFile() names (.env, keys, source maps) */
  pack(dir: string, o: { maxBytes: number; skip?: 'private' }): Promise<Packed | { tooBig: true }>;
  unpack(file: string, dest: string): Promise<{ files: number }>;
  /** what a publish refuses: the words (file, line, what it looks like; never the key) or null */
  scanApp(file: string): Promise<string | null>;
}
export const BUNDLE_PORT: ServiceRef<BundlePort> = {
  id: 'stuff.bundle',
  major: 1,
  permissions: { pack: 'stuff:read', unpack: 'stuff:save', scanApp: 'stuff:read' },
  readOnly: ['pack', 'scanApp'],
};

// ---------- uploads (owner: the edge, v1 services/uploads.js) ----------

export interface UploadsPort {
  /** an upload that came in: where its bytes are */
  get(id: string): { id: string; path: string } | null;
  remove(id: string): void;
}
export const UPLOADS_PORT: ServiceRef<UploadsPort> = {
  id: 'server.uploads',
  major: 1,
  permissions: { get: 'uploads:read', remove: 'uploads:write' },
  readOnly: ['get'],
};

// ---------- the secret scan (owner: wisp.git, v1 secret-scan.js) ----------

export interface SecretScanPort {
  /** every secret in `text` replaced with `[redacted: <what>]` */
  redact(text: string): { text: string; hits: number };
}
export const SECRET_SCAN_PORT: ServiceRef<SecretScanPort> = {
  id: 'git.secrets',
  major: 1,
  permissions: { redact: 'git:read' },
  readOnly: ['redact'],
};

// ---------- crew blueprints (owner: wisp.crew, v1 crew-share.js) ----------

export interface CrewPort {
  /** a member by id: name, kit, as a share's preview needs them */
  get(id: string): { id: string; name: string; kit: Json[] } | null;
  /** v1 exportCrew(ids, { kit: true, notebook: false, team: false }): the bundle, and each member's key */
  exportBlueprints(ids: string[]): { bundle: Json; keys: string[] };
  /** v1 importCrew in share.js: key → the member here (made, or one of yours with the same name and brief) */
  importBlueprints(file: Json): Promise<{ members: { key: string; id: string; name: string; agent: string; model: string; effort: string; role: string; paused: boolean }[]; notes: string[] }>;
  /** names of the members you have (by handle) */
  handles(): string[];
}
export const CREW_PORT: ServiceRef<CrewPort> = {
  id: 'crew.blueprints',
  major: 1,
  permissions: { get: 'crew:read', exportBlueprints: 'crew:read', importBlueprints: 'crew:write', handles: 'crew:read' },
  readOnly: ['get', 'exportBlueprints', 'handles'],
};

// ---------- commands this plugin expects others to define ----------

export const EXPECTED = {
  /** wisp.runtime: a new task with turns it didn't run (a shared task's history), idle unless prompt */
  runtimeImport: 'runtime.import', // ImportSessionArgs → { id }
  /** wisp.runtime (v1 places.js checkout): your checkout of a repo, cloned when you have none */
  checkout: 'runtime.checkout', // { repo } → { dir }
} as const;

export interface ImportSessionArgs {
  id?: string;
  prompt: string;
  cwd: string;
  agent: string;
  model: string;
  effort: string;
  mode: 'plan' | 'edits' | 'auto';
  title: string;
  history: Json[];
  parentId?: string;
  member?: string;
  subagents?: Json[];
  worktree?: Json;
  children?: Record<string, string>;
  /** owned by the caller: ext['wisp.grid-client'] = { sharedFrom } */
  ext?: Record<string, Json>;
  idle: boolean;
}
