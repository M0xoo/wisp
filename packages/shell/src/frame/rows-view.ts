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
  // a question waits for you (an ask, a stalled goal): that's what the task's state says, whatever the last turn said
  if (s.state === 'waiting') return { label: t('shell.status.waiting'), tone: 'warn' };
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

export interface OverlapRow {
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

/** A turn's time as v1 shows it: `369ms`, `12s`, `3m 4s`, `1h 2m`. */
export function duration(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n}ms`;
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A turn's files and lines: each edit counts its new text's lines added and its old text's lines removed. */
export function changeFigures(changes: readonly { readonly file: string; readonly edits?: readonly unknown[] }[]): { files: number; plus: number; minus: number } {
  const lines = (s: unknown): number => (typeof s === 'string' && s !== '' ? s.replace(/\n$/, '').split('\n').length : 0);
  let plus = 0;
  let minus = 0;
  for (const c of changes) {
    for (const e of c.edits ?? []) {
      const x = e as { before?: unknown; after?: unknown };
      plus += lines(x.after);
      minus += lines(x.before);
    }
  }
  return { files: new Set(changes.map((c) => c.file)).size, plus, minus };
}

/** Older turns fold away behind one line once a task has more than `keep` (v1 transcript.js): the newest stay. */
export function folded<T>(turns: readonly T[], open: boolean, keep = 3): { hidden: number; shown: readonly T[] } {
  if (open || turns.length <= keep + 1) return { hidden: 0, shown: turns };
  return { hidden: turns.length - keep, shown: turns.slice(-keep) };
}

/** v1 turns.js renderBody: a turn landing while you read never pushes what you read behind Show earlier (F-page-44).
 *  `from`: the first turn shown when the reader left the end; the window keeps it and grows instead of sliding. */
export function foldedFrom<T extends { readonly id: string }>(turns: readonly T[], open: boolean, from: string | undefined, keep = 3): { hidden: number; shown: readonly T[] } {
  const f = folded(turns, open, keep);
  if (from === undefined || f.hidden === 0) return f;
  const i = turns.findIndex((t) => t.id === from);
  return i < 0 || i >= f.hidden ? f : { hidden: i, shown: turns.slice(i) };
}

/** The crew member a task is a job of (`body.ext["wisp.crew"].id`), or undefined. */
export function crewOf(s: Pick<SessionRow, 'body'>): string | undefined {
  const c = (s.body?.['ext'] as Readonly<Record<string, unknown>> | undefined)?.['wisp.crew'] as { id?: unknown } | undefined;
  return typeof c?.id === 'string' ? c.id : undefined;
}

/** A row whose fields live in its `body` (a `crew_member`: `{id, name, updated_at, body}`), read flat; a flat row is its own. */
export function flatRow<T>(row: unknown): T {
  const r = (row ?? {}) as Record<string, unknown>;
  const body = r['body'];
  if (!body || typeof body !== 'object') return r as T;
  const { body: _b, ...top } = r;
  return { ...(body as Record<string, unknown>), ...top } as T;
}

/** Where Back goes from a task on a phone (v1 #773): a subagent's run goes to its lead (on the same computer), any
 * other task back through history (undefined). */
export function backOf(key: string, row: { readonly parent_id?: string | null } | undefined): string | undefined {
  const parent = row?.parent_id;
  if (!parent) return undefined;
  const at = key.indexOf(':');
  return at > 0 ? `${key.slice(0, at)}:${parent}` : parent;
}

/** A project as the screens show it: wisp.runtime's `project` row (`{id: name, body: spec}`) flattened. */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly color: string;
}

/** The setting that keeps your project order (v1 #772): one list of names, used everywhere projects show. */
export const PROJECT_ORDER = 'runtime.projectOrder';

/** The projects in your order: the ones you placed first, as you placed them, then the rest by name. */
export function projectList(rows: readonly unknown[], order: unknown): ProjectView[] {
  const placed = Array.isArray(order) ? order.filter((x): x is string => typeof x === 'string') : [];
  const all = rows.map((r) => {
    const p = flatRow<{ id?: unknown; name?: unknown; path?: unknown; color?: unknown }>(r);
    const id = String(p.id ?? '');
    // a folder as one string: `wisp add .` kept "/repo/." (and a trailing "/"), which then held none of its tasks
    const path = String(p.path ?? '')
      .replace(/(\/\.)+$/, '')
      .replace(/(.)\/+$/, '$1');
    return { id, name: typeof p.name === 'string' && p.name ? p.name : id, path, color: String(p.color ?? '') };
  });
  const at = (id: string): number => {
    const i = placed.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return all.filter((p) => p.id).sort((a, b) => at(a.id) - at(b.id) || a.name.localeCompare(b.name));
}

/** The project a folder is in (v1 `projectFor`): the one whose path holds it, the deepest when they nest. */
export function projectOf(cwd: string | undefined, projects: readonly ProjectView[]): ProjectView | undefined {
  if (!cwd) return undefined;
  const inside = (root: string): boolean => {
    const r = root.replace(/\/+$/, '');
    return !!r && (cwd === r || cwd.startsWith(`${r}/`));
  };
  return projects.filter((p) => inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
}

/** The order after dragging `id` to where `to` is (before it; at the end when `to` is undefined). */
export function movedOrder(current: readonly ProjectView[], id: string, to: string | undefined): string[] {
  const ids = current.map((p) => p.id).filter((x) => x !== id);
  const i = to === undefined ? -1 : ids.indexOf(to);
  ids.splice(i < 0 ? ids.length : i, 0, id);
  return ids;
}

/** v1 #… (feed.js next): after Mark done, archive or delete, the task that needs you next (the newest in Needs you,
 *  not archived, not a subagent's, not the one just left), else none (New task). */
export function nextNeedsYou(rows: readonly SessionRow[], leaving: string): string | undefined {
  const bare = (id: string): string => id.slice(id.indexOf(':') + 1);
  const left = bare(leaving);
  return rows
    .filter((s) => bare(s.id) !== left && !s.archived && !s.parent_id && sectionOf(s) === 'needs')
    .reduce<SessionRow | undefined>((best, s) => (!best || s.updated_at > best.updated_at ? s : best), undefined)?.id;
}
