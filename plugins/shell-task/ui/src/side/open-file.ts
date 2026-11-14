// Open file… (v1 features/editor.js openFileFinder): any file of the task's folder, picked by name in the palette
// narrowed to it (the files this task changed first), then, after a pause in typing, where the words are inside the
// files (`worktrees.grep {q}`). A pick opens the file view beside the task, at the line for a text hit. The palette
// rows are pure (`file-items.ts`); `openFinder` asks for the list once per opening.
import { createSignal } from 'solid-js';
import { defineCommand, type EntityKey, type PluginClient } from '@wisp/client';
import type { PaletteSourceDef } from '@wisp/shell/contract';
import { fileItems, hitItems, type Hit, type OpenAt } from './file-items.ts';

export const FILES_SOURCE = 'shell-task.files';

interface FileList {
  readonly files: readonly string[];
  readonly more: number;
  readonly git: boolean;
}

const listFiles = defineCommand<{ key: EntityKey; id: string }, FileList>({
  id: 'worktrees.files',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id }),
  optimistic: 'none',
  pending: 'Open file…',
});
const grepText = defineCommand<{ key: EntityKey; id: string; q: string }, Hit[]>({
  id: 'worktrees.grep',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id, q: a.q }),
  optimistic: 'none',
  pending: 'Open file…',
});

/** What the narrowed palette lists: the task's files, the changed ones marked. */
interface Finder {
  readonly task: string;
  readonly changed: ReadonlySet<string>;
  readonly files: readonly string[];
}
const [finder, setFinder] = createSignal<Finder | undefined>(undefined);

/** The file view beside the task, at `line` when there's one (`file#L12`, FilePane's `placeOf`). */
function opener(client: PluginClient, task: string): OpenAt {
  return (path, line) => client.navigate({ t: 'openSide', side: { kind: 'changes', id: task as never, file: line ? `${path}#L${line}` : path } });
}

/**
 * Open file…: the palette opens at once on this source alone, the list fills in when it comes; an empty folder or one
 * that isn't git closes it with v1's words.
 */
export function openFinder(
  client: PluginClient,
  task: string,
  changed: readonly string[],
  say: { readonly placeholder: string; readonly title: string; readonly empty: string; readonly noGit: string; readonly toast: (text: string) => void },
): void {
  setFinder({ task, changed: new Set(changed), files: [] });
  client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.palette' as never, params: { only: [FILES_SOURCE], placeholder: say.placeholder, title: say.title } } });
  void client.run(listFiles, { key: task as EntityKey, id: task.slice(task.indexOf(':') + 1) }).then(
    (r) => {
      if (finder()?.task !== task) return;
      if (r.files.length === 0) {
        client.navigate({ t: 'closeOverlay', id: 'shell.palette' as never });
        say.toast(r.git ? say.empty : say.noGit);
        return;
      }
      setFinder({ task, changed: new Set(changed), files: r.files });
    },
    () => client.navigate({ t: 'closeOverlay', id: 'shell.palette' as never }),
  );
}

/** The palette source: nothing in ⌘K, the task's files when Open file… narrowed the palette to it. */
export const filesSource: PaletteSourceDef = {
  id: FILES_SOURCE,
  order: 5,
  items: (ctx) => {
    const f = finder();
    return ctx.narrowed && f ? fileItems(f.files, f.changed, opener(ctx.client, f.task)) : [];
  },
  deep: async (q, ctx, signal) => {
    const f = finder();
    if (!ctx.narrowed || !f) return [];
    const hits = await ctx.client.run(grepText, { key: f.task as EntityKey, id: f.task.slice(f.task.indexOf(':') + 1), q });
    return signal.aborted ? [] : hitItems(hits, opener(ctx.client, f.task));
  },
};
