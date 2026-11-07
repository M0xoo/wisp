// @wisp-plugin/automations-api: the contract of wisp.automations (triggers, recipes, inbound hooks).
// The schedule helpers are pure and exported here because crew check-ins and scheduled triggers
// both read schedules (v1 server/triggers.js + web/js/schedule.js). No I/O, no node: imports.

export { ScheduleError, CRON_ALIASES, parseCron, cronMatches, nextRun, readSchedule } from './cron.ts';
export type { Cron } from './cron.ts';
export { toCron, compact, DAY_NAMES } from './words.ts';
export { cronWords, clock24, midSentence } from './says.ts';

/** Triggers that start when an outside service calls their secret URL. */
export const HOOK_KINDS: ReadonlySet<string> = new Set(['webhook', 'slack', 'linear']);
/** Triggers that fire from a task's events. */
export const TASK_KINDS: ReadonlySet<string> = new Set(['finished', 'done']);
/** Triggers that poll GitHub through `gh`. */
export const GH_KINDS: ReadonlySet<string> = new Set(['ci', 'issues']);
/** What the crew editor's "Also starts when" offers. */
export const MEMBER_KINDS: ReadonlySet<string> = new Set(['finished', 'done', 'ci']);
/** Every trigger kind. */
export const TRIGGER_KINDS: ReadonlySet<string> = new Set(['schedule', 'ci', 'issues', 'finished', 'done', ...HOOK_KINDS]);
