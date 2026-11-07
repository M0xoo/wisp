// What every piece of the list shares while it is on screen: the shell's context, the model, one
// ticking clock for the rows' times, and the list's own UI state (the row whose menu is open, the
// rename and delete dialogs). A context, so a row needs no props beyond its key.

import { createContext, useContext, type Accessor } from 'solid-js';
import type { EntityKey, PluginClient } from '@wisp/client';
import type { ShellContext } from '@wisp/shell/contract';
import type { ActionCtx } from '../actions.ts';
import type { ListModel } from '../state.ts';
import type { RowContext } from '../model/row.ts';
import type { Agent, Row } from '../types.ts';

export interface ListEnv {
  readonly shell: ShellContext;
  readonly client: PluginClient;
  readonly model: ListModel;
  readonly actions: ActionCtx;
  readonly now: Accessor<number>;
  /** the open task's key, from navigation */
  readonly open: Accessor<EntityKey | undefined>;
  /** the task the keyboard is on */
  readonly selected: Accessor<string | undefined>;
  readonly split: Accessor<boolean>;
  /** swipes mark done on this device (the phone app) */
  readonly swipes: boolean;
  /** keyboard hints are shown (not on touch screens) */
  readonly keys: boolean;
  readonly rowCtx: (key: EntityKey) => RowContext;
  openTask(key: EntityKey): void;
  readonly agents: Accessor<ReadonlyMap<string, Row<Agent>>>;
  /** the row whose menu is open (or about to: a right-click sets it before the menu reads it) */
  readonly menuFor: Accessor<EntityKey | undefined>;
  setMenuFor(key: EntityKey): void;
  /** the More button: the shared row menu opens under it */
  menuAt(key: EntityKey, el: HTMLElement): void;
  readonly renaming: Accessor<EntityKey | undefined>;
  readonly deleting: Accessor<EntityKey | undefined>;
  askRename(key: EntityKey | undefined): void;
  askDelete(key: EntityKey | undefined): void;
}

export const Env = createContext<ListEnv>();

export function useEnv(): ListEnv {
  const e = useContext(Env);
  if (!e) throw new Error('a list row renders inside TaskList');
  return e;
}
