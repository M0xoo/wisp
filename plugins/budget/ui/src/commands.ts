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
}

export interface Window {
  readonly id: string;
  readonly label: string;
  /** 0–100 */
  readonly used: number;
  readonly resetsAt?: number | null;
}

export interface AccountPlan {
  readonly account: string;
  readonly at?: number | null;
  readonly windows: readonly Window[];
}

export const usage = defineCommand<{ peer: PeerId; days?: number }, Usage>({ id: 'runtime.usage', owner: (a) => a.peer, wire: (a) => (a.days ? { days: a.days } : {}), optimistic: 'none', pending: 'the usage line' });

export const plans = defineCommand<{ peer: PeerId; agent: string }, AccountPlan[]>({ id: 'budget.view', owner: (a) => a.peer, wire: (a) => ({ agent: a.agent }), optimistic: 'none', pending: 'the plan windows' });

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
