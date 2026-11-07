// My Stuff's view model (v1 web/js/features/stuff.js): what the page shows for a list of items,
// a search, a kind and a star filter, grouped by time or by task. Pure: the page and the tests
// read the same rules.

import { kindOf, KINDS } from './kinds.ts';
import type { Item, StuffKind } from './types.ts';

export type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string;
export type Layout = 'grid' | 'list';
export type Grouping = 'time' | 'task';
export type KindFilter = StuffKind | 'all';

export interface Filter {
  readonly query: string;
  readonly kind: KindFilter;
  readonly starred: boolean;
}

export const words = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Found by every word: title, name, note, #tags, the task it came from, its address, kind, language, a doc's opening. */
export function matches(it: Item, ws: readonly string[], t: Translate): boolean {
  if (!ws.length) return true;
  const tags = (it.tags ?? []).map((x) => `#${x}`).join(' ');
  const hay = `${it.title} ${it.name} ${it.note ?? ''} ${tags} ${it.from?.title ?? ''} ${it.url ?? ''} ${t(kindOf(it.kind).many)} ${it.lang ?? ''} ${(it.excerpt ?? '').slice(0, 600)}`.toLowerCase();
  return ws.every((w) => hay.includes(w));
}

export function shownItems<T extends Item>(items: readonly T[], f: Filter, t: Translate): T[] {
  const ws = words(f.query);
  return items.filter((x) => (f.kind === 'all' || x.kind === f.kind) && (!f.starred || x.starred) && matches(x, ws, t));
}

export interface KindChip {
  readonly id: KindFilter;
  readonly count: number;
}

/**
 * All, then each kind there's something of, with how many match the words and star. No chips when
 * everything is one kind (unless a kind is picked). A picked kind nothing is left of falls back to All.
 */
export function kindChips(items: readonly Item[], f: Filter, t: Translate): { chips: KindChip[]; kind: KindFilter } {
  const ws = words(f.query);
  const base = items.filter((x) => (!f.starred || x.starred) && matches(x, ws, t));
  const have = KINDS.filter((k) => items.some((x) => x.kind === k.id));
  const kind: KindFilter = f.kind !== 'all' && !have.some((k) => k.id === f.kind) ? 'all' : f.kind;
  if (have.length <= 1 && kind === 'all') return { chips: [], kind };
  return { chips: [{ id: 'all', count: base.length }, ...have.map((k) => ({ id: k.id, count: base.filter((x) => x.kind === k.id).length }))], kind };
}

export interface Group<T> {
  readonly key: string;
  readonly label: string;
  readonly items: T[];
  /** by task: the task, when it's still there */
  readonly task?: string;
}

export interface GroupWords {
  readonly t: Translate;
  readonly now: number;
  /** the task's title as the list has it now, if it's there */
  readonly task: (id: string) => string | undefined;
  readonly month: (at: number, withYear: boolean) => string;
}

/** Today, Yesterday, This week, then months; or by the task each came from, in the list's order. */
export function groupItems<T extends Item>(list: readonly T[], by: Grouping, w: GroupWords): Group<T>[] {
  const out = new Map<string, { key: string; label: string; items: T[]; task?: string }>();
  const add = (key: string, label: string, it: T, task?: string): void => {
    let g = out.get(key);
    if (!g) out.set(key, (g = { key, label, items: [], ...(task !== undefined && { task }) }));
    g.items.push(it);
  };
  if (by === 'task') {
    for (const it of list) {
      const id = it.from?.session;
      if (!id) add('you', w.t('stuff.group.you'), it);
      else {
        const now = w.task(id);
        add(`t:${id}`, now ?? it.from?.title ?? w.t('stuff.group.aTask'), it, now === undefined ? undefined : id);
      }
    }
    return [...out.values()];
  }
  const day = new Date(w.now);
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  for (const it of list) {
    if (it.at >= today) add('today', w.t('stuff.group.today'), it);
    else if (it.at >= today - 864e5) add('yesterday', w.t('stuff.group.yesterday'), it);
    else if (it.at >= today - 6 * 864e5) add('week', w.t('stuff.group.week'), it);
    else {
      const d = new Date(it.at);
      add(`${d.getFullYear()}-${d.getMonth()}`, w.month(it.at, d.getFullYear() !== day.getFullYear()), it);
    }
  }
  return [...out.values()];
}

// --- what a card says -------------------------------------------------------------------------------

export const ext = (it: Pick<Item, 'name'>): string => (/\.(\w{1,6})$/.exec(it.name || '')?.[1] ?? '').toUpperCase();
export const texty = (it: Pick<Item, 'excerpt'>): boolean => typeof it.excerpt === 'string';
export const bare = (u: string): string => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
/** The public link has an older version than this one. */
export const behind = (it: Pick<Item, 'published' | 'rev'>): boolean => !!it.published && (it.published.rev ?? 1) !== (it.rev ?? 1);
export const canPublish = (it: Item, targets: number): boolean => it.kind === 'app' && !it.pending && (!!it.published || targets > 0);
export const canCopy = (it: Item): boolean => it.kind === 'link' || it.kind === 'image' || (texty(it) && it.kind !== 'app');
export const canDownload = (it: Item): boolean => it.kind !== 'link' && it.kind !== 'app';

export function fmtSize(n: number): string {
  if (!(n > 0)) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[i]}`;
}

/** "App · 2 files · 12 KB", "Doc · MD · 180 B", "Link · example.com". */
export function cardMeta(it: Item, t: Translate): string {
  const k = kindOf(it.kind);
  const e = ext(it);
  const what = t(k.one) + (it.lang ? ` · ${it.lang}` : (it.kind === 'file' || it.kind === 'doc') && e ? ` · ${e}` : '');
  const files = it.files ? t('stuff.card.files', { count: it.files }) : '';
  return [what, files, it.size ? fmtSize(it.size) : '', it.kind === 'link' ? it.name : ''].filter(Boolean).join(' · ');
}

/** A card's time: the hour today, the day this year, else month and year. */
export function when(at: number, now: number, locale?: string): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(locale, d.getFullYear() === n.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
}

export const totalBytes = (items: readonly Item[]): number => items.reduce((n, x) => n + (x.size || 0), 0);

/** The @ picker: titles starting with the letters first, then a word in the title, then the rest. */
export function stuffMatches<T extends Item>(items: readonly T[], q: string, n = 6): T[] {
  const list = items.filter((x) => !x.pending);
  if (!q) return [...list].sort((a, b) => Number(!!b.starred) - Number(!!a.starred)).slice(0, n);
  const score = (x: T): number => {
    const title = x.title.toLowerCase();
    if (title.startsWith(q)) return 3;
    if (title.split(/[\s\-_.,:/]+/).some((w) => w.startsWith(q))) return 2;
    return `${x.name} ${(x.tags ?? []).join(' ')} ${x.note ?? ''}`.toLowerCase().includes(q) ? 1 : 0;
  };
  return list
    .map((x) => [x, score(x)] as const)
    .filter(([, s]) => s)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([x]) => x);
}

/**
 * An agent saved or updated something while you weren't looking at My Stuff: the newest such item,
 * once. `before`: id → rev from the last list (undefined the first time: nothing is news then).
 */
export function agentNews<T extends Item>(before: ReadonlyMap<string, number> | undefined, items: readonly T[], looking: boolean): { seen: Map<string, number>; news?: T; updated?: boolean } {
  const seen = new Map(items.map((x) => [x.id, x.rev ?? 1]));
  if (!before || looking) return { seen };
  const news = items
    .filter((x) => x.by === 'agent' && (before.get(x.id) ?? 0) < (x.rev ?? 1))
    .sort((a, b) => (b.updatedAt ?? b.at) - (a.updatedAt ?? a.at))[0];
  return news ? { seen, news, updated: before.has(news.id) } : { seen };
}

/** A pasted screenshot has no name of its own: `pasted-2026-11-08-10-04-05.png`. */
export function pastedName(name: string, type: string, at: Date, i: number): string {
  if (name && name !== 'image.png') return name;
  const stamp = at.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `pasted-${stamp}${i ? `-${i}` : ''}.${(type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
}
