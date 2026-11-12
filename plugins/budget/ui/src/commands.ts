// Settings → Usage's reads and writes: the 7-day line (runtime.usage), each plan's windows (budget.view), and
// Automations stop at (budget.setStop, shown at once on the settings row).
import { defineCommand, entityKey, type PeerId } from '@wisp/client';

export const TOPIC = 'plugin:wisp.budget:plan';
export const META = 'budget_meta';

export interface Usage {
  readonly from: number;
  readonly spend: number;
  readonly turns: number;
  readonly worked: number | null;
  readonly questions: number;
  /** v1's Charts and breakdowns (runtime-api UsageSummary, additive 2026-11-12) */
  readonly priced?: number;
  readonly sessions?: number;
  readonly daily?: readonly { readonly date: string; readonly cost: number; readonly turns: number }[];
  readonly projects?: readonly UsageRow[];
  readonly runners?: readonly UsageRow[];
}

export interface UsageRow {
  readonly key: string;
  readonly name: string;
  readonly agent?: string;
  readonly cost: number;
  readonly priced: number;
  readonly turns: number;
  readonly worked: number | null;
  readonly questions: number;
  readonly avgMs: number | null;
}

export interface Window {
  readonly id: string;
  readonly label: string;
  /** 0–1 (budget-api WindowView.used) */
  readonly used: number;
  readonly resetsAt?: number | null;
  /** when it runs out at this pace, if before the reset */
  readonly hitAt?: number | null;
  /** the window's length */
  readonly ms?: number | null;
}

import type { Drain, Notice } from './drain.ts';

export interface AccountPlan {
  readonly account: string;
  readonly at?: number | null;
  readonly windows: readonly Window[];
  /** Drain watch: this account's plan moving faster than usual (budget's Drain) */
  readonly drain?: Drain | null;
  /** window changes not hidden yet */
  readonly notices?: readonly Notice[];
}

export const usage = defineCommand<{ peer: PeerId; days?: number }, Usage>({
  id: 'runtime.usage',
  owner: (a) => a.peer,
  wire: (a) => (a.days ? { days: a.days } : {}),
  optimistic: 'none',
  pending: 'the usage line',
});

export const plans = defineCommand<{ peer: PeerId; agent: string }, AccountPlan[]>({
  id: 'budget.view',
  owner: (a) => a.peer,
  wire: (a) => ({ agent: a.agent }),
  optimistic: 'none',
  pending: 'the plan windows',
});

/** `autoStop`, `autoStopClaude`, `autoStopCodex`: 'off' | '50' | '75' | '90', 'same' for a harness's own. */
export const setStop = defineCommand<{ peer: PeerId; key: string; value: string }>({
  id: 'budget.setStop',
  owner: (a) => a.peer,
  wire: (a) => ({ key: a.key, value: a.value }),
  optimistic: (base, a) => {
    const id = entityKey(a.peer, 'settings');
    const row = base.peek<{ id: string; body: Record<string, string> }>(META, id);
    return [{ e: META, id, op: 'upsert', v: { id: 'settings', body: { ...(row?.body ?? {}), [a.key]: a.value } } }];
  },
});

/** The drain card's Dismiss and a window change's ×: hidden until it happens again. */
export const dismissDrain = defineCommand<{ peer: PeerId; agent: string; account: string; window: string }>({
  id: 'budget.dismissDrain',
  owner: (a) => a.peer,
  wire: (a) => ({ agent: a.agent, account: a.account, window: a.window }),
  optimistic: 'none',
  pending: 'Dismiss',
});
export const dismissNotice = defineCommand<{ peer: PeerId; agent: string; account: string; window: string }>({
  id: 'budget.dismissNotice',
  owner: (a) => a.peer,
  wire: (a) => ({ agent: a.agent, account: a.account, window: a.window }),
  optimistic: 'none',
  pending: 'the ×',
});
