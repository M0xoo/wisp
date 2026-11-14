// Save to My Stuff on a reply's picture, video, doc and code (v1 web/js/features/stuff.js keepCtx, toggleSave): the
// kit's KeepButton asks this. The key is the task, the turn and what the button names, so the same thing saved twice
// is one item (the peer answers the one kept) and every button on it lights up from the `stuff.item` rows. A save
// shows its card in My Stuff at once (a placeholder row) and runs on the task's computer, which copies the file the
// task names (`stuff.task-files@1`); a refusal takes the card back with the red toast (the command runner's).
import { entityKey, ownerOf, type EntityKey, type PeerId } from '@wisp/client';
import { useSignal, type KeepHost } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { ITEM, keepKey, keepRemove, keepSave, shownOf, type Kept, type SaveArgs } from './keep-ops.ts';

/** Save to My Stuff for one turn's answer of task `task` (its entity key), kept in this computer's My Stuff (`home`):
 *  the page watches this computer's items. A task on another computer hands over its text (code, docs); its pictures
 *  and videos have no button, as their bytes would have to come through this page (v1 uploaded them). */
export function keepHost(shell: ShellContext, home: PeerId, task: EntityKey, turn: string): KeepHost {
  const here = ownerOf(task) === home;
  const session = task.slice(task.indexOf(':') + 1);
  const run = shell.client.commands.run;
  const keptAs = (rows: readonly Kept[], key: string): Kept | undefined => rows.find((r) => r.from?.key === key);
  const quiet = (): void => undefined;
  return {
    files: here,
    saved: (what) => {
      // called while the button sets up, so the list stays live in it
      const rows = useSignal(shell.client.entities.list<Kept>(ITEM));
      const key = keepKey(task, turn, what);
      return () => !!keptAs((rows() ?? []) as readonly Kept[], key);
    },
    toggle: (what, it) => {
      if (it.text === undefined && !here) return;
      const key = keepKey(task, turn, what);
      // a click, not a tracked read; a refusal is the command runner's red toast (and its rollback)
      const have = keptAs(shell.client.entities.list<Kept>(ITEM)() as readonly Kept[], key);
      // still saving: its placeholder has no id the peer knows yet
      if (have?.pending) return;
      if (have) {
        run(keepRemove, { key: entityKey(home, have.id), id: have.id }).catch(quiet);
        return;
      }
      const tmp = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const args: SaveArgs = {
        peer: home,
        temp: entityKey(home, tmp),
        // a file goes by the task's own name for it (its computer copies it); text goes as it is
        ...(it.text === undefined && it.path !== undefined && { file: it.path }),
        ...(it.text !== undefined && { text: it.text }),
        ...(it.name && { name: it.name }),
        ...(it.lang && { lang: it.lang }),
        ...(it.title && { title: it.title }),
        from: { session, turn, key },
        shown: shownOf(tmp, it, key, Date.now()),
      };
      run(keepSave, args).then(
        () => shell.toast.success(shell.t('shell.keep.saved'), { action: { label: shell.t('shell.keep.open'), onClick: () => shell.navigate({ t: 'openView', id: 'stuff.page' as never, params: null }) } }),
        quiet,
      );
    },
  };
}
