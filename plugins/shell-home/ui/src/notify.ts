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
  if (g.status === 'met') return (g.round ?? 1) > 1 ? t('home.notify.metRounds', { title: r.title, n: g.round ?? 1 }) : t('home.notify.met', { title: r.title });
  return t(`home.notify.${g.status}`, { title: r.title });
}

/**
 * The notice a change deserves, or null. It fires on the edge: a run that ended (running → not)
 * or a question that appeared. A task run in several places says so once, when its last run ends.
 */
export function noticeFor(prev: TaskRow | undefined, next: TaskRow, o: { siblings: readonly TaskRow[]; t: T }): Notice | null {
  const { t } = o;
  if (next.archived) return null;
  const asks = asking(next) && !(prev && asking(prev));
  const finished = prev?.state === 'running' && next.state !== 'running' && !asking(next);
  if (!asks && !finished) return null;
  if (next.crew) {
    const name = next.crew.name ?? '';
    const head = asks ? t('home.notify.memberAsks', { name, title: next.title }) : t('home.notify.member', { name, title: next.title });
    return { tag: next.id, head, title: `${name}: ${next.title}`, body: (asks ? next.question : next.preview) ?? '', asks };
  }
  if (asks) {
    const head = next.approval ? t('home.notify.approval', { title: next.title }) : t('home.notify.question', { title: next.title });
    return { tag: next.id, head, title: titleOf(next), body: next.question ?? '', asks };
  }
  const runs = next.groupId ? o.siblings.filter((x) => x.groupId === next.groupId && !x.archived) : [];
  if (runs.length > 1 && runs.some((x) => x.id !== next.id && x.state === 'running')) return null; // the last run says it
  const goal = goalVerb(next, t);
  const head = goal ?? (runs.length > 1 ? t('home.notify.runs', { title: next.title, n: runs.length }) : t('home.notify.ready', { title: next.title }));
  const body = goal ? (next.goal?.last?.why ?? '') : next.preview || t('home.notify.bodyReady');
  return { tag: next.id, head, title: titleOf(next), body, asks };
}

const titleOf = (r: TaskRow): string => (r.project ? `${r.project}: ${r.title}` : r.title);

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
  const viewing = (key: EntityKey): boolean => {
    const main = d.nav?.().main;
    return main?.kind === 'task' && main.id === (key as string) && d.focused();
  };
  const tell = (key: EntityKey, n: Notice): void => {
    if (viewing(key)) return;
    d.toast?.show(n.head, { action: { label: t('home.notify.open'), onClick: () => client.navigate({ t: 'openFromToast', target: target(key) }) } });
    if (!d.focused()) void d.platform.notify({ title: n.title, body: n.body, tag: n.tag, target: target(key) });
  };
  // read without tracking: a row's effect must not wake for every other row
  const siblings = (): TaskRow[] => untracked(() => client.entities.list<TaskRow>(SESSION)() as TaskRow[]);
  const follow = (key: EntityKey): void => {
    const cell = { prev: client.entities.peek<TaskRow>(SESSION, key) as TaskRow | undefined, stop: () => {} };
    cell.stop = effect(() => {
      const next = client.entities.row<TaskRow>(SESSION, key)() as TaskRow | undefined;
      // the first run only records where the row is: a reload doesn't announce every task again
      const prev = cell.prev;
      cell.prev = next;
      if (!next || prev === next) return;
      const n = noticeFor(prev, next, { siblings: next.groupId ? siblings() : [], t });
      if (n) untracked(() => tell(key, n)); // what is open is read, not followed
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

