// wisp.connectors' tables (forward-only) and entity kinds. A connector's row holds what it is; its
// secret values are in the secrets service, never here (v1 kept them out of config.json the same way).

import { defineEntity } from '@wisp/store';
import type { EntityDef, Migration } from '@wisp/store';
import { TOPIC } from '@wisp-plugin/connectors-api';
import type { Connector } from '@wisp-plugin/connectors-api';

export const OWNER = 'wisp.connectors';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE connectors_connector (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      added_at INTEGER NOT NULL,
      body TEXT NOT NULL
    ) STRICT;
    CREATE TABLE connectors_dismissed (name TEXT PRIMARY KEY) STRICT;`,
  },
];

export interface ConnectorRow {
  [k: string]: unknown;
  id: string;
  name: string;
  added_at: number;
  body: Connector;
}

export interface DismissedRow {
  [k: string]: unknown;
  name: string;
}

export const CONNECTOR: EntityDef<ConnectorRow> = defineEntity<ConnectorRow>({
  kind: 'connectors.connector',
  table: 'connectors_connector',
  key: 'id',
  columns: { id: 'text', name: 'text', added_at: 'int', body: 'text' },
  json: ['body'],
  topics: () => [TOPIC],
});

export const DISMISSED: EntityDef<DismissedRow> = defineEntity<DismissedRow>({
  kind: 'connectors.dismissed',
  table: 'connectors_dismissed',
  key: 'name',
  columns: { name: 'text' },
  topics: () => [TOPIC],
});

export const toRow = (c: Connector): ConnectorRow => ({ id: c.id, name: c.name, added_at: c.addedAt, body: c });
