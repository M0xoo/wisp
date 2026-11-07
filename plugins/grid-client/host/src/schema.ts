// wisp.grid-client's table (forward-only migrations: add the next one, never edit a shipped one).
//
//   grid_client_computer  this computer on a grid (v1 config.computer) and its tunnel's state: one row,
//                         id 'this', on the plugin's computer topic so the page follows it.
//
// Sign-ins in progress, the sandboxes' Claude sign-in and a launch's steps are minutes long and
// nobody resumes them: notices (the notify service), as v1's broadcasts were. Grid peers are machines
// rows; their tokens are secrets.

import type { EntityDef, Migration, Row, Store } from '@wisp/store';
import { ENTITY_COMPUTER, PLUGIN, TOPIC_COMPUTER } from '@wisp-plugin/grid-client-api';
import type { TunnelState } from '@wisp-plugin/grid-client-api';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE grid_client_computer (
        id TEXT PRIMARY KEY,
        on_grid INTEGER NOT NULL,
        grid TEXT NOT NULL,
        account TEXT NOT NULL,
        computer TEXT NOT NULL,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        previews INTEGER NOT NULL,
        state TEXT NOT NULL,
        error TEXT NOT NULL
      ) STRICT;
    `,
  },
];

interface ComputerTableRow extends Row {
  id: string;
  on_grid: boolean;
  grid: string;
  account: string;
  computer: string;
  url: string;
  name: string;
  previews: boolean;
  state: string;
  error: string;
}

/** v1 config.computer: { grid, account, id, url, name, previews }, plus the tunnel's live state. */
export interface ComputerRow {
  id: 'this';
  on: boolean;
  grid: string;
  /** the cloud computer (peer id) this computer is on the grid as */
  account: string;
  /** its id on the grid */
  computer: string;
  url: string;
  name: string;
  previews: boolean;
  state: TunnelState;
  error: string;
}

export interface Tables {
  computer(): ComputerRow | null;
  setComputer(row: ComputerRow | null): void;
}

const STATES: readonly TunnelState[] = ['off', 'connecting', 'online', 'retrying', 'gone'];

export function openTables(store: Store): Tables {
  store.migrate(PLUGIN, MIGRATIONS);
  const def: EntityDef<ComputerTableRow> = store.defineEntity<ComputerTableRow>({
    kind: ENTITY_COMPUTER,
    table: 'grid_client_computer',
    key: 'id',
    columns: { id: 'text', on_grid: 'bool', grid: 'text', account: 'text', computer: 'text', url: 'text', name: 'text', previews: 'bool', state: 'text', error: 'text' },
    topics: () => [TOPIC_COMPUTER],
  });
  // the row is read on every request through the tunnel (previews) and every view: kept in memory,
  // the store holds what survives a restart
  let cached: ComputerRow | null | undefined;
  const read = (): ComputerRow | null => {
    const r = store.get(def, 'this');
    if (!r) return null;
    const state = STATES.find((s) => s === r.state) ?? 'off';
    return { id: 'this', on: r.on_grid, grid: r.grid, account: r.account, computer: r.computer, url: r.url, name: r.name, previews: r.previews, state, error: r.error };
  };
  return {
    computer: () => (cached === undefined ? (cached = read()) : cached),
    setComputer(row) {
      store.tx((w) => {
        if (!row) w.del(def, 'this');
        else w.upsert(def, { id: 'this', on_grid: row.on, grid: row.grid, account: row.account, computer: row.computer, url: row.url, name: row.name, previews: row.previews, state: row.state, error: row.error });
      });
      cached = row;
    },
  };
}
