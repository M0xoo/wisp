// What wisp.goal uses of the plugins beside it, by the names the crew row fixed. wisp.budget, wisp.crew
// and wisp.router are written in parallel: their names are mirrored here structurally (same ids,
// majors, methods, command ids) and every use is optional (`tryUse`, a failed command is "nobody
// there"), so a goal works with none of them. Swap these for imports from their api packages once
// those export them.
import type { ServiceRef } from '@wisp/kernel';

/** What holds back work nobody started by hand on an account (Automations stop at, the machine). */
export interface Hold {
  agent: string;
  account: string;
  until?: number;
  why: string;
  load?: boolean;
}

export interface BudgetService {
  hold(agent: string, account?: string): Hold | null | Promise<Hold | null>;
  resetAt(agent: string, account?: string): number | null | Promise<number | null>;
}

export const budgetService: ServiceRef<BudgetService> = {
  id: 'budget.service',
  major: 1,
  permissions: { hold: 'budget:read', resetAt: 'budget:read' },
  readOnly: ['hold', 'resetAt'],
};

/** wisp.crew: a member who judges a goal, on their own harness (`crew.get` → Member). */
export const CREW_GET = 'crew.get';
export interface CrewMember {
  id: string;
  name: string;
  role?: string;
  agent: string;
  model?: string;
  effort?: string;
}

/** wisp.router: the pick Auto would make (`router.decide`, StartArgs with agent 'auto'). */
export const ROUTER_DECIDE = 'router.decide';
export interface RouterPick {
  agent: string;
  model?: string;
  effort?: string;
}
