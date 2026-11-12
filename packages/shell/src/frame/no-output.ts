// *No output for 12 min* in the working panel (v1 web/js/no-output.js, F-task-36): a plain fact about a running
// turn, words only, that counts up and clears by itself on its next sign of life. DOM-free.

/** Measured on 2,583 stored v1 turns: Bash's 10-minute cap makes a cliff at 10.5 min. */
export const NO_OUTPUT_MS = 12 * 60_000;

export interface QuietStep {
  readonly kind?: string | undefined;
  /** when it happened */
  readonly t?: number | undefined;
  /** when its result came in (a call's output) */
  readonly outAt?: number | undefined;
  /** a call id: a subagent call stays open while it works */
  readonly call?: string | undefined;
  readonly output?: unknown;
}

/** When the turn last showed a sign of life: its start, or its newest step or result. */
export function lastOutputAt(startedAt: number, steps: readonly QuietStep[]): number {
  let newest = startedAt;
  for (const a of steps) {
    if ((a.t ?? 0) > newest) newest = a.t ?? 0;
    if ((a.outAt ?? 0) > newest) newest = a.outAt ?? 0;
  }
  return newest;
}

/** A built-in subagent (Claude's Task) is a call that stays open while it works: no output from it isn't quiet. */
// v2 sends a call's result as its own `tool_output` step with the call's id: open until that step comes
const subagentOpen = (steps: readonly QuietStep[]): boolean =>
  steps.some((a) => a.kind === 'agent' && !!a.call && !a.outAt && a.output === undefined && !steps.some((o) => o.kind === 'tool_output' && o.call === a.call));

/**
 * The words for a turn at `now`, or ''. Only while it runs and nobody is asked anything, and not while a delegate
 * or a subagent of it still works.
 */
export function noOutputLine(
  o: { readonly running: boolean; readonly waiting: boolean; readonly startedAt: number; readonly steps: readonly QuietStep[]; readonly delegating?: boolean },
  now: number,
  t: (key: string, p?: Readonly<Record<string, string | number>>) => string,
): string {
  if (!o.running || o.waiting) return '';
  const quiet = now - lastOutputAt(o.startedAt, o.steps);
  if (quiet < NO_OUTPUT_MS || o.delegating || subagentOpen(o.steps)) return '';
  const min = Math.floor(quiet / 60_000);
  if (min < 60) return t('shell.work.noOutput', { min });
  const rest = min % 60;
  return rest ? t('shell.work.noOutputHours', { h: Math.floor(min / 60), min: rest }) : t('shell.work.noOutputHour', { h: Math.floor(min / 60) });
}
