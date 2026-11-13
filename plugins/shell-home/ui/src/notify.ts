// Notifications when a task finishes or asks (v1 web/js/features/notify.js): a toast in the app,
// and a system notification through the platform module when wisp isn't in front. The decider is
// pure (`noticeFor`): a row's previous and next value in, the words out. The wiring follows each
// row with its own effect, so a change to one task costs one comparison, never a pass over the list.

import { effect, untracked, type EntityKey, type Nav, type PluginClient, type SessionId, type Target } from '@wisp/client';
import type { Platform } from '@wisp/shell/platform';
import type { Toaster } from '@wisp/ui';
import { SESSION, type TaskRow } from './types.ts';

export type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

export interface Notice {
  readonly tag: string;
  /** the toast's line and the notification's title */
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly asks: boolean;
}

const asking = (r: TaskRow): boolean => !!(r.question || r.approval);
const GOAL_END = new Set(['met', 'impossible', 'out', 'paused']);

/** What a goal's end says, or undefined when the goal hasn't ended. */
function goalVerb(r: TaskRow, t: T): string | undefined {
  const g = r.goal;
  if (!g || !GOAL_END.has(g.status)) return undefined;
  if (g.status === 'met') return (g.round ?? 1) > 1 ? t('shell-home.notify.metRounds', { title: r.title, n: g.round ?? 1 }) : t('shell-home.notify.met', { title: r.title });
  return t(`shell-home.notify.${g.status}`, { title: r.title });
}

/**
 * The notice a change deserves, or null. It fires on the edge: a run that ended (running → not)
 * or a question that appeared. A task run in several places says so once, when its last run ends.
 */
export function noticeFor(prev: TaskRow | undefined, next: TaskRow, o: { siblings: readonly TaskRow[]; t: T; member?: (id: string) => string | undefined }): Notice | null {
  const { t } = o;
  if (next.archived) return null;
  const asks = asking(next) && !(prev && asking(prev));
  const finished = prev?.state === 'running' && next.state !== 'running' && !asking(next);
  if (!asks && !finished) return null;
  // a member's job: their name says who's reporting (v1 notify.js); one that left reads as any task
  const name = next.crew ? (next.crew.name ?? (next.crew.id ? o.member?.(next.crew.id) : undefined)) : undefined;
  if (next.crew && name) {
    const head = asks ? t('shell-home.notify.memberAsks', { name, title: next.title }) : t('shell-home.notify.member', { name, title: next.title });
    return { tag: next.id, head, title: `${name}: ${next.title}`, body: (asks ? next.question : next.preview) ?? '', asks };
  }
  if (asks) {
    const head = next.approval ? t('shell-home.notify.approval', { title: next.title }) : t('shell-home.notify.question', { title: next.title });
    return { tag: next.id, head, title: titleOf(next), body: next.question ?? '', asks };
  }
  const runs = next.groupId ? o.siblings.filter((x) => x.groupId === next.groupId && !x.archived) : [];
  if (runs.length > 1 && runs.some((x) => x.id !== next.id && x.state === 'running')) return null; // the last run says it
  const goal = goalVerb(next, t);
  const head = goal ?? (runs.length > 1 ? t('shell-home.notify.runs', { title: next.title, n: runs.length }) : t('shell-home.notify.ready', { title: next.title }));
  const body = goal ? (next.goal?.last?.why ?? '') : next.preview || t('shell-home.notify.bodyReady');
  return { tag: next.id, head, title: titleOf(next), body, asks };
}

/** A key's id: `<peer>:<id>` → `<id>` (an id alone stays). */
const bareId = (k: string): string => k.slice(k.indexOf(':') + 1);

const titleOf = (r: TaskRow): string => (r.project ? `${r.project}: ${r.title}` : r.title);

/** A session row as the store keeps it (`body` and `summary` json columns) read flat, as the list reads it:
 * the summary's `question`, `approval`, `preview`, `goal` at the top. A flat row is its own. */
export function flatRow(raw: unknown): TaskRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const top = raw as Record<string, unknown>;
  const part = (k: string): Record<string, unknown> => (top[k] && typeof top[k] === 'object' ? (top[k] as Record<string, unknown>) : {});
  if (!('body' in top) && !('summary' in top)) return raw as TaskRow;
  const out: Record<string, unknown> = { ...part('body') };
  for (const [k, v] of Object.entries(top)) if (k !== 'body' && k !== 'summary') out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  Object.assign(out, part('summary'));
  // a crew member's job: the crew's note in `ext` (CrewExt), read as `crew` (the list reads it the same way)
  const job = (out['ext'] as Record<string, unknown> | undefined)?.['wisp.crew'] as { id?: unknown } | undefined;
  if (job && typeof job.id === 'string' && out['crew'] === undefined) out['crew'] = { id: job.id };
  if (out['question'] === '') delete out['question'];
  if (out['approval'] === false) delete out['approval'];
  return out as unknown as TaskRow;
}

export interface NotifierDeps {
  readonly client: PluginClient;
  readonly platform: Platform;
  readonly toast?: Toaster;
  readonly nav?: () => Nav;
  /** wisp is in front (the window has focus, the app is in the foreground) */
  readonly focused: () => boolean;
}

/** Follows every task row; tells you when one finishes or asks, unless you're looking at it. */
export function startNotifier(d: NotifierDeps): () => void {
  const { client } = d;
  const t: T = (k, v) => client.t(k, v);
  const rows = new Map<EntityKey, { prev: TaskRow | undefined; stop: () => void }>();
  const target = (key: EntityKey): Target => ({ to: 'main', main: { kind: 'task', id: key as string as SessionId } });
  // a crew member's name, from the crew's rows (`{id, name, body}`)
  const member = (id: string): string | undefined => {
    const r = untracked(() => (client.entities.list<{ id: string; name?: string; body?: { name?: string } }>('crew_member')() as readonly { id: string; name?: string; body?: { name?: string } }[]).find((x) => x.id === id));
    return r?.body?.name ?? r?.name;
  };
  const viewing = (key: EntityKey, row: TaskRow): boolean => {
    const main = d.nav?.().main;
    if (!d.focused()) return false;
    // the task itself is open, or (a member's job) their thread is (v1: not while it's in view)
    return (main?.kind === 'task' && main.id === (key as string)) || (!!row.crew?.id && main?.kind === 'crew' && bareId(String(main.id)) === row.crew.id);
  };
  const tell = (key: EntityKey, n: Notice, row: TaskRow): void => {
    if (viewing(key, row)) return;
    d.toast?.show(n.head, { action: { label: t('shell-home.notify.open'), onClick: () => client.navigate({ t: 'openFromToast', target: target(key) }) } });
    if (!d.focused()) void d.platform.notify({ title: n.title, body: n.body, tag: n.tag, target: target(key) });
  };
  // read without tracking: a row's effect must not wake for every other row
  const siblings = (): TaskRow[] => untracked(() => (client.entities.list<unknown>(SESSION)() as unknown[]).map(flatRow).filter((r): r is TaskRow => r !== undefined));
  const follow = (key: EntityKey): void => {
    const cell = { prev: flatRow(client.entities.peek<unknown>(SESSION, key)), stop: () => {} };
    cell.stop = effect(() => {
      const next = flatRow(client.entities.row<unknown>(SESSION, key)());
      // the first run only records where the row is: a reload doesn't announce every task again
      const prev = cell.prev;
      cell.prev = next;
      if (!next || prev === next) return;
      const n = noticeFor(prev, next, { siblings: next.groupId ? siblings() : [], t, member });
      if (n) untracked(() => tell(key, n, next)); // what is open is read, not followed
    });
    rows.set(key, cell);
  };
  const stopAll = effect(() => {
    const keys = new Set(client.entities.keys(SESSION)());
    // untracked: a row's effect made here must not belong to this one (it would end on the next key change)
    untracked(() => {
      for (const [k, c] of rows) if (!keys.has(k)) (c.stop(), rows.delete(k));
      for (const k of keys) if (!rows.has(k)) follow(k);
    });
  });
  const offOpen = d.platform.onOpen((to) => client.navigate({ t: 'openFromToast', target: to }));
  return () => {
    stopAll();
    offOpen();
    for (const c of rows.values()) c.stop();
    rows.clear();
  };
}

