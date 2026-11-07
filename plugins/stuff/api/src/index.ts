// @wisp-plugin/stuff-api: the contract of wisp.stuff, the plugin that owns My Stuff (what you and your
// agents kept from tasks: pictures, videos, docs, code, files, links and apps), the apps' launches and
// their databases, and uploads (attachments). Other plugins depend on this package only (ADR-0003).
//
// Shapes follow v1's records (server/services/stuff.js, services/uploads.js) so the importer maps 1:1
// and v1 clients read the same JSON.

import type { ServiceRef } from '@wisp/kernel';

export const PLUGIN = 'wisp.stuff';

export type StuffKind = 'image' | 'video' | 'doc' | 'code' | 'file' | 'link' | 'app';
export const KINDS: readonly StuffKind[] = ['image', 'video', 'doc', 'code', 'file', 'link', 'app'];

/** Where an item came from: the task (its title as it was then) and turn, plus the page's key for "already saved". */
export interface StuffFrom {
  session?: string;
  title?: string;
  turn?: string;
  key?: string;
}

/** Where an app is published (the publisher's `stuff.setPublished`). */
export interface Published {
  url: string;
  account?: string;
  host?: string;
  handle?: string;
  rev?: number;
  at?: number;
}

/** What makes up an item's content: kept whole as the one previous version (`prev`). */
export interface StuffContent {
  kind: StuffKind;
  name: string;
  mime?: string;
  size?: number;
  path?: string;
  source?: string;
  lang?: string;
  excerpt?: string;
  url?: string;
  entry?: string;
  files?: number;
  db?: { seed: string };
  uses?: string[];
  by?: string;
  at: number;
}

/** One item as this computer keeps it (v1's `<id>.json`): paths included. Never sent to a page. */
export interface StuffItem {
  id: string;
  kind: StuffKind;
  name: string;
  title: string;
  mime?: string;
  size: number;
  at: number;
  /** 'you', 'agent' or 'wisp' (a starter) */
  by: string;
  path?: string;
  source?: string;
  lang?: string;
  excerpt?: string;
  url?: string;
  entry?: string;
  files?: number;
  db?: { seed: string };
  uses?: string[];
  /** what you allowed a pane, as stored; `grant` says what holds now */
  allowed?: string[];
  /** the app's code hash a write grant is tied to */
  grantHash?: string;
  cover?: string;
  from?: StuffFrom;
  note?: string;
  tags?: string[];
  starred?: boolean;
  rev?: number;
  updatedAt?: number;
  prev?: StuffContent;
  published?: Published;
}

/** What a page sees of an item (v1 Stuff.view): no paths on this computer, the grant as it holds now. */
export interface StuffView {
  id: string;
  kind: StuffKind;
  name: string;
  title: string;
  mime?: string;
  size: number;
  at: number;
  by: string;
  lang?: string;
  excerpt?: string;
  url?: string;
  entry?: string;
  files?: number;
  uses?: string[];
  from?: StuffFrom;
  note?: string;
  tags?: string[];
  starred?: boolean;
  rev?: number;
  updatedAt?: number;
  published?: Published;
  allowed?: string[];
  changed?: true;
  risky?: string[];
  prev?: { at: number; size?: number; by?: string };
  cover?: true;
  /** it has a database, and `data` says whether it has any yet (Reset data) */
  db?: true;
  data?: boolean;
  /** launched, on this port of 127.0.0.1 */
  running?: { port: number };
}

/** An attachment (v1 services/uploads.js): the raw body on disk, referenced by id from launches. */
export interface Upload {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface Grant {
  allowed: string[];
  changed: boolean;
}

// ---------- commands (permission in brackets) ----------

/** `stuff.save`: exactly one of url, text, file (a path on this computer) or app (a folder). */
export interface SaveArgs {
  url?: string;
  text?: string;
  file?: string;
  app?: string;
  /** text: its file name (notes.md); file: the name it's kept under */
  name?: string;
  lang?: string;
  /** app: a picture of it, for its card */
  cover?: string;
  title?: string;
  note?: string;
  tags?: unknown;
  from?: StuffFrom;
  by?: string;
  /** update this item in place: the content before it stays as the one previous version */
  replace?: string;
}

export const COMMANDS = {
  list: 'stuff.list', // {} → StuffView[]   [stuff:read] (newest first)
  get: 'stuff.get', // { id } → StuffItem | null   [stuff:read] (paths included: for agents and plugins on this computer)
  find: 'stuff.find', // { query?, kind?, limit? } → { items: StuffItem[], text }   [stuff:read] (wisp_stuff's list)
  describe: 'stuff.describe', // { id } → { text } | null   [stuff:read] (one item in full, for an agent: @-mentions, wisp_stuff)
  grant: 'stuff.grant', // { id } → Grant   [stuff:read]
  save: 'stuff.save', // SaveArgs → StuffView   [stuff:save]
  update: 'stuff.update', // { id, title?, note?, tags?, starred? } → StuffView   [stuff:save]
  restore: 'stuff.restore', // { id } → StuffView   [stuff:save]
  remove: 'stuff.remove', // { id } → { ok }   [stuff:save]
  allow: 'stuff.allow', // { id, uses, task? } → StuffView   [stuff:allow] (the user only: agent sets must deny it)
  setPublished: 'stuff.setPublished', // { id, published: Published | null } → StuffView   [stuff:publish]
  launch: 'stuff.launch', // { id } → { port, url }   [stuff:launch]
  stop: 'stuff.stop', // { id } → { ok }   [stuff:launch]
  resetData: 'stuff.resetData', // { id } → StuffView   [stuff:save]
  upload: 'stuff.upload', // { id } → Upload | null   [stuff:read] (an attachment's record)
  uploads: 'stuff.uploads', // { ids } → Upload[]   [stuff:read] (v1 uploads.resolve: unknown ids dropped)
  removeUpload: 'stuff.removeUpload', // { id } → { ok }   [stuff:save]
  reserveUpload: 'stuff.reserveUpload', // { name } → { id, file }   [stuff:save] (a file to fill in: a moved task's bundle)
  commitUpload: 'stuff.commitUpload', // { id, name } → Upload   [stuff:save] (the reserved file is written)
} as const;

// ---------- events (after commit) ----------

export const EVENTS = {
  /** an agent saved or updated an item for a task: its answer shows it as a card (v1 savedStuff) */
  saved: 'stuff.saved', // { session, id, by }
  removed: 'stuff.removed', // { id }
} as const;

// ---------- topics ----------

/** Every item's page view, one row per item (entity 'stuff.item'). */
export const TOPIC = 'stuff';
/** The records with their paths on this computer (entity 'stuff.local'): server-side readers only. */
export const TOPIC_LOCAL = 'stuff:local';
/** Attachments' records (entity 'stuff.upload'). */
export const TOPIC_UPLOADS = 'uploads';

// ---------- the publisher (provided by wisp.machines' publish) ----------

/** Where an app can be published (v1 app.publish.targets()). */
export interface PublishTarget {
  id: string;
  [k: string]: unknown;
}

/** An app's public link on your wisp Grid (v1 services/publish.js). The provider writes `published` with stuff.setPublished. */
export interface PublishService {
  targets(): PublishTarget[];
  publish(id: string, opts?: { account?: string }): Promise<StuffItem>;
  unpublish(id: string): Promise<StuffItem>;
}

export const PUBLISH_SERVICE: ServiceRef<PublishService> = {
  id: 'stuff.publish',
  major: 1,
  permissions: { targets: 'stuff:read', publish: 'stuff:publish', unpublish: 'stuff:publish' },
  readOnly: ['targets'],
};

export * from './pane.ts';
export { PANE_EXAMPLE, paneGuide, paneReference } from './pane-guide.ts';
export { appScanTexts, realSecret, secretsFound, type MatchAt } from './app-scan.ts';
