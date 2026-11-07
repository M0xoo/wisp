// wisp.stuff's tables (forward-only, owner 'wisp.stuff') and entity kinds. A record keeps v1's JSON
// shape whole in `record` (paths on this computer included), on a topic only the server reads; the
// page's view of it is its own row on the `stuff` topic, so no path or grant hash reaches a client.

import { defineEntity } from '@wisp/store';
import type { EntityDef, Migration } from '@wisp/store';
import { TOPIC, TOPIC_LOCAL, TOPIC_UPLOADS } from '@wisp-plugin/stuff-api';
import type { StuffItem, StuffView, Upload } from '@wisp-plugin/stuff-api';

export const OWNER = 'wisp.stuff';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE stuff_local (id TEXT PRIMARY KEY, at INTEGER NOT NULL, from_key TEXT, record TEXT NOT NULL) STRICT;
      CREATE INDEX stuff_local_at ON stuff_local (at DESC);
      CREATE INDEX stuff_local_key ON stuff_local (from_key) WHERE from_key IS NOT NULL;
      CREATE TABLE stuff_item (id TEXT PRIMARY KEY, at INTEGER NOT NULL, view TEXT NOT NULL) STRICT;
      CREATE TABLE stuff_upload (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
    `,
  },
];

export interface LocalRow {
  [k: string]: unknown;
  id: string;
  at: number;
  from_key: string | null;
  record: StuffItem;
}

export interface ItemRow {
  [k: string]: unknown;
  id: string;
  at: number;
  view: StuffView;
}

export interface UploadRow {
  [k: string]: unknown;
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  at: number;
}

export const LOCAL: EntityDef<LocalRow> = defineEntity<LocalRow>({
  kind: 'stuff.local',
  table: 'stuff_local',
  key: 'id',
  columns: { id: 'text', at: 'int', from_key: 'text', record: 'text' },
  json: ['record'],
  topics: () => [TOPIC_LOCAL],
});

export const ITEM: EntityDef<ItemRow> = defineEntity<ItemRow>({
  kind: 'stuff.item',
  table: 'stuff_item',
  key: 'id',
  columns: { id: 'text', at: 'int', view: 'text' },
  json: ['view'],
  topics: () => [TOPIC],
});

export const UPLOAD: EntityDef<UploadRow> = defineEntity<UploadRow>({
  kind: 'stuff.upload',
  table: 'stuff_upload',
  key: 'id',
  columns: { id: 'text', name: 'text', mime: 'text', size: 'int', path: 'text', at: 'int' },
  topics: () => [TOPIC_UPLOADS],
});

export const uploadOf = (r: UploadRow): Upload => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, path: r.path });
