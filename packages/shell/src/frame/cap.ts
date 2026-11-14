// A task's mode cap (F-chan-10, runtime's `capped` list field): a task a channel started stays at Edits or lower
// until the user picks a mode above the cap in wisp, which lifts it. Pure: the task page reads it, setMode's
// optimistic patch uses it.

export type CapMode = 'plan' | 'edits';

const RANK: Readonly<Record<string, number>> = { plan: 0, edits: 1, auto: 2 };

/** The cap a task's row carries; a row without one, or with one no mode names, is uncapped. */
export function capOf(summary: Readonly<Record<string, unknown>> | undefined): CapMode | undefined {
  const c = summary?.['capped'];
  return c === 'plan' || c === 'edits' ? c : undefined;
}

/** Picking `mode` on a task capped at `cap` takes the cap off (the user's switch above it). */
export function lifts(mode: string, cap: CapMode | undefined): boolean {
  return cap !== undefined && (RANK[mode] ?? RANK['auto']!) > RANK[cap]!;
}
