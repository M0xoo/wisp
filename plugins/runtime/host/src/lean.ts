// Lean Claude Code runs (v1 server/lean.js, setting runtime.leanRuns): no telemetry, error reporting
// or update checks, 5 connections at start instead of 12. It also turns the claude.ai connectors and
// every server-rolled feature off, so by default ('on') it is only for wisp's own side runs (judges,
// the scout, review, the retro); 'all' makes every Claude run lean, 'off' none. A task's own `lean`
// ('on' | 'off') wins for that task's runs.

import type { Session } from './model.ts';

export const LEAN_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
export const LEAN_VALUES = ['off', 'on', 'all'] as const;
export type LeanMode = (typeof LEAN_VALUES)[number];

const mode = (setting: unknown): LeanMode => (LEAN_VALUES.includes(setting as LeanMode) ? (setting as LeanMode) : 'on');

/** A side run wisp makes for itself: lean unless the setting is off. */
export const leanOn = (setting: unknown): boolean => mode(setting) !== 'off';

/** A task's run: lean only when the task asked for it or the setting is 'all'. */
export function leanTask(s: Pick<Session, 'lean'>, setting: unknown): boolean {
  if (s.lean === 'on' || s.lean === 'off') return s.lean === 'on';
  return mode(setting) === 'all';
}
