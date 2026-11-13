// What an answer's blocks may ask of the open task (BlockContext, packages/ui/src/blocks/types.ts): send a reply,
// put text in the reply box, run a command in the task's folder (and show what it did), open another task or a
// link, allow or deny a blocked turn, read another task's title and state. Live only on the latest answer.
import type { EntityKey } from '@wisp/client';
import { entityKey, ownerOf } from '@wisp/client';
import { useSignal, type BlockContext, type EnvReveal, type StuffRef, type TaskRef } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { usePluginClient } from '../slot.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { appState, approveBlocked, exec, reveal } from './commands.ts';
import { mediaUrl } from './answer-of.ts';

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
  /** which masked .env views show (env-reveal.ts), built once per turn; without it a block keeps its own Reveal */
  readonly env?: EnvReveal;
  /** what the turn's `app` blocks saved (`ext["wisp.apps"]`) */
  readonly apps: () => Readonly<Record<string, unknown>>;
}

export function answerContext(h: AnswerHost): BlockContext {
  const { shell, key } = h;
  const run = shell.client.commands.run;
  const peer = ownerOf(key);
  // called while a view sets up (TaskView, Compare): the shell's own client says which wisp is this one
  const home = usePluginClient('shell').home;
  const keyOf = (id: string): EntityKey => (id.includes(':') ? (id as EntityKey) : entityKey(peer, id));
  return {
    // a .env file's values in a code or diff block: masked, revealed per task for the tab's life (env-reveal.ts)
    ...(h.env && { env: h.env }),
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
