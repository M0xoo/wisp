// What an answer's blocks may ask of the open task (BlockContext, packages/ui/src/blocks/types.ts): send a reply,
// put text in the reply box, run a command in the task's folder (and show what it did), open another task or a
// link, allow or deny a blocked turn, read another task's title and state. Live only on the latest answer.
import type { EntityKey } from '@wisp/client';
import { entityKey, ownerOf } from '@wisp/client';
import { useSignal, type BlockContext, type StuffRef, type TaskRef } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { appState, approveBlocked, exec } from './commands.ts';

export interface AnswerHost {
  readonly shell: ShellContext;
  readonly key: EntityKey;
  readonly turnId: string;
  /** this answer is the task's latest (read live: a new turn makes the older answers inert) */
  readonly latest: () => boolean;
  readonly reply: (text: string) => void;
  readonly draft: (text: string) => void;
  readonly openChanges: () => void;
  /** what the turn's `app` blocks saved (`ext["wisp.apps"]`) */
  readonly apps: () => Readonly<Record<string, unknown>>;
}

export function answerContext(h: AnswerHost): BlockContext {
  const { shell, key } = h;
  const run = shell.client.commands.run;
  const peer = ownerOf(key);
  const keyOf = (id: string): EntityKey => (id.includes(':') ? (id as EntityKey) : entityKey(peer, id));
  return {
    get latest() {
      return h.latest();
    },
    reply: h.reply,
    draft: h.draft,
    run: async (command) => {
      const at = Date.now();
      const r = await run(exec, { id: key, command });
      return { exitCode: r.code, output: r.output, durationMs: Date.now() - at };
    },
    allow: () => run(approveBlocked, { id: key, turnId: h.turnId, allow: true }),
    deny: () => run(approveBlocked, { id: key, turnId: h.turnId, allow: false }),
    openTask: (id) => shell.navigate({ t: 'openTask', id: keyOf(id) as never }),
    openUrl: (url) => shell.platform.openExternal(url),
    openFile: () => h.openChanges(),
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
