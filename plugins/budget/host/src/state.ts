// What budget knows of each account (v1 budget.json, now rows: rows.ts), as the model works on it in
// memory. One `Acc` per agent@account; 'default' is the CLI's own login.

import type { Banked, OverageKind, Period } from '@wisp-plugin/budget-api';

export interface Win {
  used: number;
  resetsAt: number | null;
  ms: number | null;
}

/** What wisp last saw of a window (window changes), so a restart doesn't announce anything again. */
export interface Seen {
  ms: number | null;
  resetsAt: number | null;
  slot: string | null;
  at: number;
  miss: number;
}

export interface NoticeRow {
  window: string;
  kind: 'new' | 'gone' | 'length' | 'reset';
  at: number;
  ms: number | null;
  resetsAt: number | null;
  wasMs?: number | null;
  wasWindow?: string;
  wasResetsAt?: number;
}

export interface DrainSample {
  at: number;
  du: number;
  units: number;
  failed?: boolean;
}

export interface Over {
  at: number;
  kind: OverageKind;
  sid?: string;
  tid?: string;
}

export interface Acc {
  windows: Record<string, Win>;
  /** the latest reading */
  at?: number;
  /** Ask near the limit: how far each window moved while wisp's runs worked, against their units */
  learn?: Record<string, { du: number; units: number }>;
  /** what moved during the run going on now, until spend() */
  run?: Record<string, number>;
  acks?: Record<string, { resetsAt: number | null; line: number }>;
  periods?: Record<string, Period[]>;
  drain?: Record<string, DrainSample[]>;
  drainSeen?: Record<string, number>;
  early?: Record<string, { at: number; resetsAt: number | null }>;
  shape?: { since: number; n: number; windows: Record<string, Seen> };
  notices?: Record<string, NoticeRow>;
  over?: Over[];
  banked?: Banked;
  bankedSent?: Record<string, number>;
  credits?: number;
}

/** Which parts of an account changed since the last write: each is its own rows. */
export type Part = 'acc' | 'windows' | 'periods' | 'drain';

export const accKey = (agent: string, account: string): string => `${agent}@${account}`;
export const splitKey = (key: string): { agent: string; account: string } => {
  const at = key.indexOf('@');
  return { agent: key.slice(0, at), account: key.slice(at + 1) };
};

export class State {
  readonly accounts = new Map<string, Acc>();
  readonly dirty = new Map<string, Set<Part>>();

  get(agent: string, account = 'default'): Acc | undefined {
    return this.accounts.get(accKey(agent, account || 'default'));
  }

  /** the account's state, made when wisp first hears of it */
  ensure(agent: string, account = 'default'): Acc {
    const key = accKey(agent, account || 'default');
    let acc = this.accounts.get(key);
    if (!acc) {
      acc = { windows: {} };
      this.accounts.set(key, acc);
    }
    return acc;
  }

  touch(agent: string, account: string, ...parts: Part[]): void {
    const key = accKey(agent, account || 'default');
    const set = this.dirty.get(key) ?? new Set<Part>();
    for (const p of parts) set.add(p);
    this.dirty.set(key, set);
  }

  /** every account of one agent: [account, acc] */
  of(agent: string): [string, Acc][] {
    const out: [string, Acc][] = [];
    for (const [key, acc] of this.accounts) {
      const k = splitKey(key);
      if (k.agent === agent) out.push([k.account, acc]);
    }
    return out;
  }
}
