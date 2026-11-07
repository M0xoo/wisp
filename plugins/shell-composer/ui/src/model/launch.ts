// New task's rules (v1 launcher.js go, services/launch.js): the optimistic card's title, what
// "Try it two ways" refuses, and the body the create command carries. Pure.

import { MODES, type Mode, type Project, type Row, type Runner, type TeamMember } from '../types.ts';
import { AUTO } from './runner.ts';

/** Up to 4 runs side by side (MAX_RUNNERS): the lead and 3 more. */
export const MAX_RUNS = 4;

/** The pending card's title: the first line, at most 64 characters, without /terminal or /sandbox. */
export function titleOf(prompt: string): string {
  const line = (prompt.replace(/^\/(terminal|sandbox)\s+/i, '').split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** Why Try it two ways can't be used right now, as an i18n key, or undefined when it can. */
export function tryRefusal(i: { readonly agent: string; readonly mode: Mode; readonly runs: number; readonly trial: boolean; readonly scratch: boolean }): string | undefined {
  if (i.agent === AUTO) return 'shell-composer.try.auto';
  if (i.mode === 'plan') return 'shell-composer.try.plan';
  if (i.scratch) return 'shell-composer.try.git';
  if (!i.trial && i.runs >= MAX_RUNS) return 'shell-composer.try.max';
  return undefined;
}

/** The next mode for Shift+Tab: plan → edits → auto → plan. */
export const nextMode = (m: Mode): Mode => MODES[(MODES.indexOf(m) + 1) % MODES.length] ?? 'auto';

/** "No folder": a general ask in an empty scratch directory. */
export const NO_FOLDER = 'none';

/** The chips of the "in" row: picked first, then the most recently used, at most `max`. */
export function projectChips(projects: readonly Row<Project>[], picked: string | null, max = 5): { shown: Row<Project>[]; more: number } {
  const recent = [...projects].sort((a, b) => (b.lastUsedAt ?? b.addedAt ?? 0) - (a.lastUsedAt ?? a.addedAt ?? 0));
  const first = recent.find((p) => p.id === picked);
  const rest = recent.filter((p) => p.id !== picked);
  const shown = [...(first ? [first] : []), ...rest].slice(0, max);
  return { shown, more: projects.length - shown.length };
}

/** The project New task starts in: the pick if it still exists, else the most recent one, else none. */
export function resolveProject(projects: readonly Row<Project>[], picked: string | null | undefined): string {
  if (picked === NO_FOLDER) return NO_FOLDER;
  if (picked && projects.some((p) => p.id === picked)) return picked;
  return projectChips(projects, null, 1).shown[0]?.id ?? NO_FOLDER;
}

export interface LaunchBody {
  prompt: string;
  cwd?: string;
  scratch?: true;
  projectId?: string;
  agent: string;
  model: string;
  effort: string;
  account?: string;
  mode: Mode;
  attachments: string[];
  worktree?: false;
  compare?: Runner[];
  trial?: true;
  subagents?: TeamMember[];
}

/**
 * The create command's body. `worktree: false` only when Worktree is off and nothing is compared
 * (v1 L:820: comparing always needs worktrees, so the peer makes them anyway).
 */
export function launchBody(i: {
  readonly prompt: string;
  readonly project: Row<Project> | undefined;
  readonly runner: Runner;
  readonly mode: Mode;
  readonly attachments: readonly string[];
  readonly worktree: boolean;
  readonly compare: readonly Runner[];
  readonly trial: boolean;
  readonly team: readonly TeamMember[];
  readonly delegates: boolean;
}): LaunchBody {
  const r = i.runner;
  const where = i.project ? { cwd: i.project.path, projectId: i.project.id } : { scratch: true as const };
  return {
    prompt: i.prompt,
    ...where,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    ...(r.account && { account: r.account }),
    mode: i.mode,
    attachments: [...i.attachments],
    ...(!i.worktree && i.compare.length === 0 && i.project && { worktree: false as const }),
    ...(i.compare.length > 0 && { compare: i.compare.map((c) => ({ ...c })) }),
    ...(i.trial && i.compare.length > 0 && { trial: true as const }),
    ...(i.team.length > 0 && i.delegates && { subagents: i.team.map((m) => ({ ...m })) }),
  };
}
