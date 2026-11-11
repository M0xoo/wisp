// Builds the ListEnv once per mounted list: the shell's alien signals turned into Solid accessors
// (navigation, the keyboard's task, the agents), one clock for the rows' times owned by a child of
// the plugin's scope (so it stops with the list), the action context, and the list's local state.

import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { useSignal } from '@wisp/ui';
import type { EntityKey, PluginClient } from '@wisp/client';
import type { ShellContext } from '@wisp/shell/contract';
import { readOnOpen, type ActionCtx } from '../actions.ts';
import { flatten, taskKeys } from '../model/flat.ts';
import { machineLabelKey } from '../model/machine.ts';
import { modelOf } from '../state.ts';
import { KIND, type Load } from '../types.ts';
import type { ListEnv } from './env.ts';

/** how often the rows' times move on */
export const TICK_MS = 30_000;

export function buildEnv(shell: ShellContext, client: PluginClient): ListEnv {
  const model = modelOf(client);
  // the project the top bar's chips picked: the list shows it (one filter, v1 wisp.filter)
  const picked = useSignal(shell.projectFilter?.value ?? (() => undefined));
  createEffect(() => {
    const f = picked();
    if (f !== undefined && f !== model.view.value().filter) model.setFilter(f);
  });
  const nav = useSignal(shell.nav);
  const selected = useSignal(shell.selection.get);
  const agents = useSignal(model.agents);
  const load = useSignal(client.entities.row<Load>(KIND.load, 'here' as EntityKey));
  const scope = client.scope.child('list');
  onCleanup(() => scope.dispose());
  const [now, setNow] = createSignal(scope.timers.now());
  scope.interval(TICK_MS, () => setNow(scope.timers.now()));
  const [menuFor, setMenuFor] = createSignal<EntityKey | undefined>(undefined);
  const [renaming, askRename] = createSignal<EntityKey | undefined>(undefined);
  const [deleting, askDelete] = createSignal<EntityKey | undefined>(undefined);
  const open = createMemo(() => {
    const m = nav().main;
    return m.kind === 'task' ? (m.id as unknown as EntityKey) : undefined;
  });
  const split = (): boolean => nav().layout === 'split';
  const swipes = shell.platform.kind === 'android';
  const here = (): string => shell.t(machineLabelKey(load()?.platform));
  /** the keyboard moves to the row's neighbour when the row it is on leaves the list */
  const handOff = (key: EntityKey): void => {
    if (selected() !== key) return;
    const order = taskKeys(flatten(model.sections(), { toggled: new Set(model.view.value().toggled), open: open(), split: split() }));
    const i = order.indexOf(key);
    shell.selection.set(order[i + 1] ?? order[i - 1]);
  };
  const actions: ActionCtx = { client, t: shell.t, toast: shell.toast, now: () => scope.timers.now(), handOff };
  return {
    shell,
    client,
    model,
    actions,
    now,
    open,
    selected,
    split,
    swipes,
    keys: !shell.platform.mobile,
    agents,
    rowCtx: (key) => ({ split: split(), open: open() === key, swipes, here: here(), sandbox: shell.t('shell-list.run.sandbox'), agents: agents() }),
    openTask: (key) => {
      shell.selection.set(key);
      client.navigate({ t: 'openTask', id: key as never });
      readOnOpen(actions, key);
    },
    menuFor,
    setMenuFor: (key) => setMenuFor(key),
    menuAt: (key, el) => {
      setMenuFor(key);
      // the one row menu is a context menu around the list: open it under the button
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
    },
    renaming,
    deleting,
    askRename: (key) => askRename(() => key),
    askDelete: (key) => askDelete(() => key),
  };
}
