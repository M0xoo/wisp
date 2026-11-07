// wisp.machines' tables (ADR-0004): peers and their live status on the `machines` topic, and the
// last rows seen from each peer with the link state that resumes from them (cursor per peer, epoch).

import type { Migration, Row } from '@wisp/store';

export const OWNER = 'wisp.machines';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE machines_peer (
        id TEXT PRIMARY KEY,
        peer TEXT,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        auto_connect INTEGER NOT NULL DEFAULT 1,
        added_at INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE TABLE machines_status (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        steps TEXT NOT NULL DEFAULT '[]',
        error TEXT NOT NULL DEFAULT '',
        hint TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        since INTEGER,
        remote TEXT,
        stale INTEGER,
        wakes INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE machines_mirror (
        key TEXT PRIMARY KEY,
        peer TEXT NOT NULL,
        id TEXT NOT NULL,
        v TEXT NOT NULL
      ) STRICT;
      CREATE INDEX machines_mirror_peer ON machines_mirror (peer);
      CREATE TABLE machines_link (
        id TEXT PRIMARY KEY,
        saved TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];

export interface PeerTable extends Row {
  id: string;
  peer: string | null;
  name: string;
  transport: string;
  address: string;
  port: number;
  command: string;
  auto_connect: boolean;
  added_at: number;
  data: Record<string, unknown>;
}

export interface StatusTable extends Row {
  id: string;
  state: string;
  steps: unknown[];
  error: string;
  hint: unknown;
  attempt: number;
  since: number | null;
  remote: unknown;
  stale: number | null;
  wakes: boolean;
}

export interface MirrorTable extends Row {
  key: string;
  peer: string;
  id: string;
  v: Record<string, unknown>;
}

export interface LinkTable extends Row {
  id: string;
  saved: unknown;
  at: number;
}

const MACHINES = ['machines'] as const;
const CACHE = ['plugin:wisp.machines:cache'] as const;

export const PEER = {
  kind: 'machine',
  table: 'machines_peer',
  key: 'id',
  columns: { id: 'text', peer: 'text', name: 'text', transport: 'text', address: 'text', port: 'int', command: 'text', auto_connect: 'bool', added_at: 'int', data: 'text' },
  json: ['data'],
  topics: () => MACHINES,
} as const;

export const STATUS = {
  kind: 'machine.status',
  table: 'machines_status',
  key: 'id',
  columns: { id: 'text', state: 'text', steps: 'text', error: 'text', hint: 'text', attempt: 'int', since: 'int', remote: 'text', stale: 'int', wakes: 'bool' },
  json: ['steps', 'hint', 'remote'],
  topics: () => MACHINES,
} as const;

/** Not for clients: they subscribe to each peer themselves. Kept so a restart shows and resumes. */
export const MIRROR = {
  kind: 'machine.mirror',
  table: 'machines_mirror',
  key: 'key',
  columns: { key: 'text', peer: 'text', id: 'text', v: 'text' },
  json: ['v'],
  topics: () => CACHE,
} as const;

export const LINK = {
  kind: 'machine.link',
  table: 'machines_link',
  key: 'id',
  columns: { id: 'text', saved: 'text', at: 'int' },
  json: ['saved'],
  topics: () => CACHE,
} as const;
