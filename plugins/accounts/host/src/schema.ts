// wisp.accounts' tables (forward-only; never edit a migration that shipped, add the next one) and
// the entity kinds the change feed carries them as.
//
// accounts_account: v1 ~/.wisp/accounts.json, one row per account, `ord` the user's order. A harness
//   with only its default account has no rows at all, as v1 kept no entry for it.
// accounts_agent: the last detection of each harness, written only when it changed, so a client
//   watching the topic hears that a harness was installed or signed in.

import { defineEntity } from '@wisp/store';
import type { EntityDef, Migration } from '@wisp/store';
import { TOPIC } from '@wisp-plugin/accounts-api';

export const OWNER = 'wisp.accounts';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE accounts_account (
        key TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        plan TEXT NOT NULL DEFAULT '',
        kind TEXT,
        signed_in INTEGER,
        limit_until INTEGER,
        limit_why TEXT,
        added_at INTEGER
      ) STRICT;
      CREATE INDEX accounts_account_agent ON accounts_account (agent, ord);
      CREATE TABLE accounts_agent (
        id TEXT PRIMARY KEY,
        row TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];

export interface AccountRow {
  [k: string]: unknown;
  /** `${agent}/${id}` */
  key: string;
  agent: string;
  id: string;
  ord: number;
  label: string;
  email: string;
  plan: string;
  /** null: guessed from the plan */
  kind: string | null;
  /** null: unknown */
  signed_in: boolean | null;
  limit_until: number | null;
  limit_why: string | null;
  added_at: number | null;
}

export interface AgentRowStored {
  [k: string]: unknown;
  id: string;
  row: unknown;
  at: number;
}

export const ACCOUNT: EntityDef<AccountRow> = defineEntity<AccountRow>({
  kind: 'accounts.account',
  table: 'accounts_account',
  key: 'key',
  columns: { key: 'text', agent: 'text', id: 'text', ord: 'int', label: 'text', email: 'text', plan: 'text', kind: 'text', signed_in: 'bool', limit_until: 'int', limit_why: 'text', added_at: 'int' },
  topics: () => [TOPIC],
});

export const AGENT: EntityDef<AgentRowStored> = defineEntity<AgentRowStored>({
  kind: 'accounts.agent',
  table: 'accounts_agent',
  key: 'id',
  columns: { id: 'text', row: 'text', at: 'int' },
  json: ['row'],
  topics: () => [TOPIC],
});

export const keyOf = (agent: string, id: string): string => `${agent}/${id}`;
