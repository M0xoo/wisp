// What the crew needs from outside itself, typed in one place: its error, the budget service it reads
// (declared here until @wisp-plugin/budget-api ships; the shape is the crew row's brief), the harnesses
// a member may run on, and small text helpers v1 kept in util.js.
import type { Json, ServiceRef } from '@wisp/kernel';

/** An error the kernel puts on the wire as {code, message}; `status` is what the v1 route answered. */
export class CrewError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Json | undefined;
  constructor(code: string, message: string, status?: number, details?: Json) {
    super(message);
    this.code = code;
    this.status = status ?? ({ not_found: 404, invalid: 400, forbidden: 403, conflict: 409, unavailable: 503 } as Record<string, number>)[code] ?? 500;
    this.details = details;
  }
}

/** v1 util.bad(msg, status): a 400 unless said otherwise. */
export function bad(message: string, status = 400): CrewError {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 429 ? 'conflict' : status === 422 ? 'invalid' : status >= 500 ? 'unavailable' : 'invalid';
  return new CrewError(code, message, status);
}

/** What holds a member's unattended jobs back (budget's "Automations stop at", or a busy computer). */
export interface Hold {
  agent: string;
  account?: string;
  until?: number;
  why: string;
  load?: boolean;
  window?: string;
  used?: number;
  stop?: number;
}

/** budget.service (owned by wisp.budget); only what the crew calls. */
export interface BudgetService {
  hold(agent: string, account?: string): Hold | null | Promise<Hold | null>;
}
export const budgetService: ServiceRef<BudgetService> = { id: 'budget.service', major: 1, permissions: { hold: 'budget:read', resetAt: 'budget:read' }, readOnly: ['hold', 'resetAt'] };

/** A job that couldn't start because of a hold: skipped, not failed (v1 err.held). */
export class HeldError extends CrewError {
  readonly held: Hold;
  constructor(h: Hold) {
    super('conflict', h.why, 409, { held: { ...h } });
    this.held = h;
  }
}

/** The harnesses a member may run on, and their names (v1 adapters, without wisp's own). */
export const HARNESS_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  grok: 'Grok',
  copilot: 'Copilot',
};
export const isHarness = (id: string): boolean => Object.hasOwn(HARNESS_NAMES, id);
export const harnessName = (id: string): string => HARNESS_NAMES[id] ?? id;

export const MODES: ReadonlySet<string> = new Set(['plan', 'edits', 'auto']);

export const truncate = (s: unknown, n: number): string => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A short random id, as v1's newId (12 hex characters). */
export const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const asObj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** Plain data for an ext slot or an event: what JSON keeps of it. */
export const toJson = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
