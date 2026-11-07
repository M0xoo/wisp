// The plan's usage windows (v1 server/budget.js): what wisp calls each, the Automations stop at
// choices, and the small pure rules every side shares (the page, the server, other plugins).

const H = 3600_000;

/** What wisp calls each window, and how long it is when the CLI doesn't say. */
export const WINDOWS: Readonly<Record<string, { label: string; ms: number }>> = {
  five_hour: { label: '5-hour', ms: 5 * H },
  seven_day: { label: 'Weekly', ms: 7 * 24 * H },
  seven_day_opus: { label: 'Weekly Opus', ms: 7 * 24 * H },
  seven_day_sonnet: { label: 'Weekly Sonnet', ms: 7 * 24 * H },
};
const ORDER = Object.keys(WINDOWS);
/** windows wisp knows first, in their order; the rest after */
export const rank = (id: string): number => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);

/** A window wisp has no name for, by its length: "30-day", "12-hour". */
export const labelOf = (ms: number | null | undefined): string => (!ms ? 'Usage' : ms >= 24 * H ? `${Math.round(ms / (24 * H))}-day` : `${Math.round(ms / H)}-hour`);
export const windowLabel = (id: string, ms: number | null | undefined): string => WINDOWS[id]?.label ?? labelOf(ms);

/** Settings → Usage → Automations stop at: 'off', or the percent of a window. */
export const STOP_AT = ['off', '50', '75', '90'] as const;
export const stopAtOf = (v: unknown): number | null => ((STOP_AT as readonly string[]).includes(String(v)) && String(v) !== 'off' ? Number(v) / 100 : null);
/**
 * The same, for one harness: its own line, or 'same' (unset) to follow Automations stop at. ChatGPT
 * and Codex share one allowance, so a Codex line lower than Claude's leaves room for your chats.
 */
export const STOP_KEYS: Readonly<Record<string, string>> = { claude: 'autoStopClaude', codex: 'autoStopCodex' };
export const STOP_BY = ['same', ...STOP_AT] as const;
export function stopFor(defaults: Readonly<Record<string, unknown>>, agent: string): number | null {
  const key = STOP_KEYS[agent];
  const own = key ? defaults[key] : undefined;
  return stopAtOf(typeof own === 'string' && (STOP_AT as readonly string[]).includes(own) ? own : defaults['autoStop']);
}

/** Two reports of the same window period: Codex's reset can drift when it only says "in n seconds". */
export const samePeriod = (a: number | null | undefined, b: number | null | undefined): boolean => !!a && !!b && Math.abs(a - b) < 10 * 60_000;

/**
 * A window that reset before its time (a banked reset): its old reset hadn't come, now much less is
 * used, and the new reset is a period later. Codex's drifting "in n seconds" alone never counts.
 */
export function resetEarly(was: { used: number; resetsAt: number | null } | undefined, next: { used: number; resetsAt: number | null }, now: number): boolean {
  if (!was?.resetsAt || was.resetsAt <= now || !next.resetsAt || next.resetsAt - was.resetsAt <= 10 * 60_000) return false;
  return was.used - next.used >= 0.25 || (next.used < 0.05 && was.used >= 0.1);
}

/**
 * When you'd use the whole window at the pace since it started, or null: not before the reset,
 * already used up, or too early to tell (under 5% gone, or the first half hour).
 */
export function paceOf(w: { used: number; resetsAt: number | null; ms: number | null }, now: number): number | null {
  const { used, resetsAt, ms } = w;
  if (!ms || !resetsAt || resetsAt <= now || !(used > 0) || used >= 1) return null;
  const spent = now - (resetsAt - ms);
  if (used < 0.05 || spent < Math.min(ms / 10, H / 2)) return null;
  const at = Math.round(now + ((1 - used) * spent) / used);
  return at < resetsAt ? at : null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A run's units of work: its cost where the harness says it, else its tokens in millions. */
export function unitsOf(stats: Readonly<Record<string, unknown>> | null | undefined): number {
  if (!stats || stats['baseline']) return 0; // a brought-in chat's first turn has no cost of its own: not a sample
  const cost = stats['costUsd'];
  if (typeof cost === 'number' && cost > 0) return cost;
  const tokens = num(stats['inputTokens']) - num(stats['cachedInputTokens']) + num(stats['outputTokens']);
  return tokens > 0 ? tokens / 1e6 : 0;
}

/**
 * What holds the work back, in words the page puts after "Waits for your plan:" (no time: the page
 * says when, in its own format): "Claude Code’s weekly window is at 78%, past your 75%".
 */
export function holdWhy(h: { label: string; used: number; stop: number }, name: string, label = ''): string {
  const win = h.label.charAt(0).toLowerCase() + h.label.slice(1);
  return `${name}${label ? ` (${label})` : ''}’s ${win} window is at ${Math.round(h.used * 100)}%, past your ${Math.round(h.stop * 100)}%`;
}

/** Drain watch's units in words: dollars for Claude, tokens for the rest. */
export const unitWords = (agent: string, u: number): string => (agent === 'claude' ? `$${u.toFixed(2)}` : `${u >= 0.1 ? u.toFixed(1) : u.toFixed(2)}M tokens`);

/**
 * Drain watch's words, for the phone (the page writes its own): "Since 14:05, 4 runs took 18% of
 * Claude Code’s 5-hour window for $2.10 of work: 3.1× its usual share per unit of work …".
 */
export function drainWhy(d: { since: number; label: string; runs: number; du: number; units: number; ratio: number; failed?: { runs: number; du: number } }, name: string, label = '', agent = name === 'Claude Code' ? 'claude' : ''): string {
  const at = new Date(d.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const win = d.label.charAt(0).toLowerCase() + d.label.slice(1);
  const p = (x: number): string => `${Math.round(x * 100)}%`;
  const failed = d.failed?.runs ? ` ${d.failed.runs} of them ended in an error and still took ${p(d.failed.du)}.` : '';
  return `Since ${at}, ${d.runs} runs took ${p(d.du)} of ${name}${label ? ` (${label})` : ''}’s ${win} window for ${unitWords(agent, d.units)} of work: ${d.ratio.toFixed(1)}× its usual share per unit of work over the last two weeks.${failed} Settings → Usage → Plan budget has the details and Copy report.`;
}

/**
 * Who started a run, as `BeforeRunCtx.by` / `StartArgs.by` say it: work nobody started by hand
 * (check-ins, triggers, goal rounds, agents' own follow-ups) is what Automations stop at holds back.
 * Anything else (you, a channel message, Compact now, a scheduled follow-up wisp.later already
 * checked) runs (v1 app.reserve, design/budget.md).
 */
export const UNATTENDED_BY: readonly string[] = ['crew', 'trigger', 'automations', 'agent', 'goal', 'review'];
export const unattended = (by: string | undefined): boolean => !!by && UNATTENDED_BY.includes(by);
