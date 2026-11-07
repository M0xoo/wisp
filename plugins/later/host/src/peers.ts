// What wisp.later uses of the plugins beside it, by the names the crew row fixed (/tmp brief,
// "Cross-plugin contracts"). wisp.budget's api is being written in parallel: its service is mirrored
// here structurally (same id, major and methods) and used through `tryUse`, so wisp.later works with
// no budget plugin at all. Swap this for `import { budgetService } from '@wisp-plugin/budget-api'`
// once that package exports it.
import type { Json, ServiceRef } from '@wisp/kernel';

/** What holds back work nobody started by hand on an account (v1 app.reserve.check: Automations stop at, the machine). */
export interface Hold {
  agent: string;
  account: string;
  until?: number;
  why: string;
  load?: boolean;
  window?: string;
  used?: number;
  stop?: number;
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

/** `budget.reset`: a window of agent's account reset early. */
export const BUDGET_RESET = 'budget.reset';
export interface BudgetReset {
  agent: string;
  account: string;
  ids?: Json;
}

/** wisp.crew: a member, as `crew.get` answers (only what later reads). */
export const CREW_GET = 'crew.get';
export interface CrewMember {
  id: string;
  name: string;
}
