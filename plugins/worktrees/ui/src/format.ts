// What the Worktrees pane says and in what order, as pure functions over the rows (v1
// web/js/features/worktrees.js): the list's entries, its filters and sort, a row's state, sizes,
// the summary line and Bring in's facts. No clock of their own: callers pass `now`.

import { t } from './i18n.ts';
import type { Entry, Filter, Leftover, Offer, WorktreeItem, WorktreesStatus } from './types.ts';

const DAY = 86_400_000;
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** v1 fmtSize: 512 B, 12 KB, 3.4 MB, 1.2 GB. */
export function fmtSize(n: number): string {
  if (n < KB) return t('worktrees.size.b', { n });
  if (n < MB) return t('worktrees.size.kb', { n: Math.round(n / KB) });
  if (n < GB) return t('worktrees.size.mb', { n: (n / MB).toFixed(1) });
  return t('worktrees.size.gb', { n: (n / GB).toFixed(1) });
}

/** A task's folders and the leftovers, as one list (v1 entries()); keys never collide. */
export function entries(items: readonly WorktreeItem[], leftovers: readonly Leftover[]): Entry[] {
  const tasks: Entry[] = items.map((x) => ({ ...x, key: `t:${x.id}`, left: false }));
  const left: Entry[] = leftovers.map((x) => ({ key: `l:${x.name}`, left: true, name: x.name, title: x.name, status: (x.only ?? 0) > 0 ? 'dirty' : 'left', only: x.only, size: x.size, used_at: x.used_at }));
  return [...tasks, ...left];
}

export const FILTERS: readonly Filter[] = ['all', 'dirty', 'kept', 'left'];

/** A filter named from outside (the pane's `filter` param); anything else is All. */
export const asFilter = (f: string | undefined): Filter => (FILTERS as readonly string[]).includes(f ?? '') ? (f as Filter) : 'all';

export function matches(filter: Filter, x: Entry): boolean {
  if (filter === 'all') return true;
  if (filter === 'left') return x.left;
  if (filter === 'kept') return x.status === 'kept';
  return x.status === 'dirty';
}

/** Biggest first, then the longest unused: what's worth removing is on top. */
export const bySize = (a: Entry, b: Entry): number => (b.size ?? 0) - (a.size ?? 0) || a.used_at - b.used_at;

export function counts(list: readonly Entry[]): Record<Filter, number> {
  const out: Record<Filter, number> = { all: 0, dirty: 0, kept: 0, left: 0 };
  for (const x of list) for (const f of FILTERS) if (matches(f, x)) out[f] += 1;
  return out;
}

/** What Clean up now takes: idle, and untouched for a day (the server's MIN_IDLE). */
export function ready(items: readonly WorktreeItem[], now: number): WorktreeItem[] {
  return items.filter((x) => x.status === 'idle' && now - x.used_at >= DAY);
}

/** The state column: why it stays, or when it goes. */
export function statusText(x: Entry, now: number): string {
  if (x.left) return x.status === 'dirty' ? t('worktrees.state.dirty', { count: x.only ?? 0 }) : '';
  if (x.status === 'dirty') return t('worktrees.state.dirty', { count: x.only });
  if (x.status === 'checking') return '';
  if (x.status !== 'idle') return t(`worktrees.state.${x.status}`);
  if (x.clean_at === null) return t('worktrees.state.idle');
  const days = Math.ceil((x.clean_at - now) / DAY);
  return days > 1 ? t('worktrees.state.goes-in', { count: days }) : t('worktrees.state.goes-next');
}

/** The summary's title: "12 worktrees · 4.2 GB". */
export function totalLine(list: readonly Entry[], status: WorktreesStatus | undefined): string {
  const n = t('worktrees.count', { count: list.length });
  if (status?.size === null || status?.size === undefined) return n;
  const size = list.reduce((a, x) => a + (x.size ?? 0), 0);
  return t('worktrees.total', { n, size: fmtSize(size) });
}

/** The summary's line: the clean-up running, else free disk and the last clean-up. */
export function diskLine(status: WorktreesStatus | undefined, ago: (at: number) => string): string {
  if (!status) return '';
  if (status.cleaning) return t('worktrees.cleaning', { done: status.cleaning.done, total: status.cleaning.total });
  const free = status.disk ? t('worktrees.free', { size: fmtSize(status.disk.free) }) : '';
  const l = status.last;
  const last = l ? t(l.freed ? 'worktrees.last-freed' : 'worktrees.last', { when: ago(l.at), n: t('worktrees.count', { count: l.count }), size: fmtSize(l.freed) }) : '';
  return [free, last].filter(Boolean).join(' · ');
}

const MAX_LISTED = 8;

/** Bring in's line under an offer: how they stand, which branches, and what can't come (v1 facts()). */
export function offerFacts(o: Offer): { said: string; branches: string[]; stuck: string } {
  const dirty = o.items.filter((x) => x.dirty > 0).length;
  const chats = o.items.filter((x) => x.chat).length;
  const more = o.items.length - MAX_LISTED;
  const said = [dirty ? t('worktrees.bring.dirty', { count: dirty }) : '', chats ? t('worktrees.bring.chats', { count: chats }) : ''].filter(Boolean).join(', ');
  const branches = [...o.items.slice(0, MAX_LISTED).map((x) => x.branch), ...(more > 0 ? [t('worktrees.bring.more', { count: more })] : [])];
  const stuck = o.detached ? t('worktrees.bring.detached', { count: o.detached }) : '';
  return { said, branches, stuck };
}
