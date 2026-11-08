// How a session row reads in v1's list (web/js/features/feed.js): its section, the state pill, the
// harness line, the goal and overlap pills, the short time. Pure, so it's tested without a page.

import type { SessionRow } from '../rows.ts';
import type { ShellContext } from '../contract.ts';

export type SectionId = 'needs' | 'working' | 'done';
export const SECTIONS: readonly SectionId[] = ['needs', 'working', 'done'];

export function sectionOf(s: SessionRow): SectionId {
  if (s.state === 'running') return 'working';
  if (s.state === 'done') return 'done';
  return 'needs';
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** v1's list time: now, 5m, 3h, 2d. */
export function shortAgo(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / DAY)}d`;
}

/** v1's hover title for a time: Sun, 8 Nov 2026, 03:28 */
export function longTime(at: number): string {
  const d = new Date(at);
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(d);
  return `${day}, ${clock}`;
}

export type Tone = 'done' | 'info' | 'warn' | 'bad' | 'live';

export function statusOf(s: SessionRow, t: ShellContext['t']): { label: string; tone: Tone } {
  const st = String(s.summary.status ?? '');
  if (s.state === 'running') return { label: t('shell.status.working'), tone: 'live' };
  if (st === 'info') return { label: t('shell.status.report'), tone: 'info' };
  if (st === 'blocked' || st === 'failed' || s.state === 'error') return { label: t('shell.status.failed'), tone: 'bad' };
  if (st === 'waiting' || st === 'partial') return { label: t('shell.status.waiting'), tone: 'warn' };
  return { label: t('shell.status.finished'), tone: 'done' };
}

interface GoalSummary {
  readonly text?: string;
  readonly status?: string;
  readonly round?: number;
  readonly checks?: readonly { readonly progress?: number }[];
  readonly last?: { readonly votes?: readonly { readonly name: string; readonly why: string }[] };
}

export function goalOf(s: SessionRow, t: ShellContext['t']): { n: number; progress: number; title: string; paused: boolean } | undefined {
  const g = s.summary['goal'] as GoalSummary | undefined;
  if (!g?.text) return undefined;
  const progress = g.checks?.[g.checks.length - 1]?.progress ?? 0;
  const paused = g.status === 'paused';
  const votes = (g.last?.votes ?? []).map((v) => `${v.name}: ${v.why}`).join(' · ');
  const title = `${t('shell.goal.doneWhen', { text: g.text })}\n${paused ? t('shell.goal.paused') : ''}${votes ? ` · ${votes}` : ''}`;
  return { n: g.round ?? 0, progress, title, paused };
}

interface OverlapRow {
  readonly id: string;
  readonly files: readonly string[];
  readonly conflicts?: readonly string[];
}

export const overlapsOf = (s: SessionRow): readonly OverlapRow[] => (s.summary['overlaps'] as OverlapRow[] | undefined) ?? [];

export function overlapLine(o: OverlapRow, t: ShellContext['t']): string {
  if (o.conflicts?.length) return t('shell.overlap.conflict', { files: o.conflicts.join(', ') });
  return t('shell.overlap.clean', { files: o.files.join(', ') });
}

export function overlapOf(s: SessionRow, titleOf: (id: string) => string, t: ShellContext['t']): { n: number; title: string } | undefined {
  const all = overlapsOf(s);
  if (!all.length) return undefined;
  return { n: all.length, title: all.map((o) => `“${titleOf(o.id)}”: ${overlapLine(o, t)}`).join('\n') };
}
