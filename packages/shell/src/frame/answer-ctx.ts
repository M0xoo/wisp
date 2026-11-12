// What an answer's blocks may ask of the open task (BlockContext, packages/ui/src/blocks/types.ts): send a reply,
// put text in the reply box, run a command in the task's folder (and show what it did), open another task or a
// link, allow or deny a blocked turn, read another task's title and state. Live only on the latest answer.
import type { EntityKey } from '@wisp/client';
import { entityKey, ownerOf } from '@wisp/client';
import { useSignal, type BlockContext, type StuffRef, type TaskRef } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { usePluginClient } from '../slot.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { appState, approveBlocked, exec, reveal } from './commands.ts';

export interface AnswerHost {
  readonly shell: ShellContext;
  readonly key: EntityKey;
  readonly turnId: string;
  /** what the turn's refusals allow (v1 #777): `allowable` (the server kept them: Allow & retry), `unallowed` (a Full
   *  auto run its harness still refused: a note, no retry), `none` */
  readonly blocked?: () => 'allowable' | 'unallowed' | 'none';
  /** this answer is the task's latest (read live: a new turn makes the older answers inert) */
  readonly latest: () => boolean;
  /** the task's title (a hero repeating it says nothing) */
  readonly title?: () => string;
  /** the transcript shows: the hero says its state and meta again (v1: not the trail then) */
  readonly transcript?: () => boolean;
  readonly meta?: () => readonly string[];
  readonly reply: (text: string) => void;
  readonly draft: (text: string) => void;
  readonly openChanges: () => void;
  /** what the turn's `app` blocks saved (`ext["wisp.apps"]`) */
  readonly apps: () => Readonly<Record<string, unknown>>;
}

/** A picture or video an answer named → a URL the page loads (v1 ctx.fileUrl): a link stays; a file comes from the
 *  task's own computer, this wisp's or another through it (`/api/peer/<machine>`). */
export function mediaUrl(home: string, key: string, path: string): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const peer = key.slice(0, key.indexOf(':'));
  const base = peer && peer !== home ? `/api/peer/${encodeURIComponent(peer)}` : '';
  return `${base}/api/sessions/${encodeURIComponent(key.slice(key.indexOf(':') + 1))}/file?path=${encodeURIComponent(path)}`;
}

export function answerContext(h: AnswerHost): BlockContext {
  const { shell, key } = h;
  const run = shell.client.commands.run;
  const peer = ownerOf(key);
  // called while a view sets up (TaskView, Compare): the shell's own client says which wisp is this one
  const home = usePluginClient('shell').home;
  const keyOf = (id: string): EntityKey => (id.includes(':') ? (id as EntityKey) : entityKey(peer, id));
  return {
    get latest() {
      return h.latest();
    },
    get inTask() {
      return !h.transcript?.();
    },
    get heroMeta() {
      return h.transcript?.() ? (h.meta?.() ?? []) : [];
    },
    get taskTitle() {
      return h.title?.() ?? '';
    },
    reply: h.reply,
    draft: h.draft,
    run: async (command) => {
      const at = Date.now();
      const r = await run(exec, { id: key, command });
      return { exitCode: r.code, output: r.output, durationMs: Date.now() - at };
    },
    get allow() {
      return (h.blocked?.() ?? 'allowable') === 'allowable' ? () => run(approveBlocked, { id: key, turnId: h.turnId, allow: true }) : undefined;
    },
    get deny() {
      return (h.blocked?.() ?? 'allowable') === 'allowable' ? () => run(approveBlocked, { id: key, turnId: h.turnId, allow: false }) : undefined;
    },
    get unallowed() {
      return h.blocked?.() === 'unallowed';
    },
    openTask: (id) => shell.navigate({ t: 'openTask', id: keyOf(id) as never }),
    openUrl: (url) => shell.platform.openExternal(url),
    openFile: () => h.openChanges(),
    media: (p) => mediaUrl(home, key, p),
    // Show in folder: only on a computer (a phone has no folder to open, v1 MOBILE)
    ...(shell.platform.kind !== 'android' && {
      revealFile: (path: string) =>
        void run(reveal, { id: key, path }).then(
          (r) => !r.ok && shell.toast.error(shell.t('shell.reveal.failed', { path: r.path })),
          (e: unknown) => shell.toast.error(e instanceof Error ? e.message : String(e)),
        ),
    }),
    appState: {
      get: (block) => h.apps()[block],
      set: (block, state) => void run(appState, { id: key, turnId: h.turnId, block, state }).catch(() => undefined),
    },
    // My Stuff's page (wisp.stuff's view); its items are `stuff.item` rows on the `stuff` topic everyone watches
    openStuff: () => shell.navigate({ t: 'openView', id: 'stuff.page' as never, params: null }),
    stuff: (id) => {
      const row = useSignal(shell.client.entities.row<{ id: string; title?: string; name?: string; kind?: string; excerpt?: string }>('stuff.item', keyOf(id)));
      return (): StuffRef | undefined => {
        const it = row();
        return it ? { id: it.id, title: it.title || it.name || '', kind: it.kind ?? '', ...(it.excerpt && { sub: it.excerpt }) } : undefined;
      };
    },
    task: (id) => {
      // called while the task block sets up, so the row stays live in it
      const row = useSignal(shell.client.entities.row<SessionRow>(SESSION, keyOf(id)));
      return (): TaskRef | undefined => {
        const s = row();
        return s ? { id: s.id, title: s.title, state: s.archived ? 'archived' : s.state, ...(s.agent && { agent: s.agent }) } : undefined;
      };
    },
  };
}

/** What a turn's refusals allow (v1 #777): the server keeps them (`ext['wisp.runtime'].blocked`) only for a run that
 *  wasn't in Full auto; a Full auto run that its harness still refused can't be retried, and a card from before
 *  has nothing to allow. */
export function blockedOf(turn: unknown): 'allowable' | 'unallowed' | 'none' {
  const o = (turn ?? {}) as { readonly ext?: Readonly<Record<string, unknown>>; readonly mode?: unknown };
  const kept = (o.ext?.['wisp.runtime'] as { readonly blocked?: unknown } | undefined)?.blocked;
  if (Array.isArray(kept) && kept.length > 0) return 'allowable';
  return o.mode === 'auto' ? 'unallowed' : 'none';
}
