// The projects every screen shows (the top bar's chips, New task's "in" row and its +N list, the Projects pane), in
// the one order you dragged them into (v1 #772, setting `runtime.projectOrder`). Rows are wisp.runtime's `project`
// kind on `config`; the order is saved at once (optimistic) and rolls back with a toast if refused.

import { createMemo, type Accessor } from 'solid-js';
import { reordered, useSignal } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { setSetting } from './commands.ts';
import { PROJECT_ORDER, projectList, type ProjectView } from './rows-view.ts';

export interface Projects {
  readonly list: Accessor<readonly ProjectView[]>;
  /** drag `id` before `before` (to the end when undefined) */
  readonly reorder: (id: string, before: string | undefined) => void;
}

export function useProjects(shell: ShellContext, home: string): Projects {
  const rows = useSignal(shell.client.entities.list<unknown>('project'));
  const settings = useSignal(shell.client.entities.list<{ key: string; value: unknown }>('setting'));
  const order = (): unknown => settings().find((s) => s.key === PROJECT_ORDER)?.value;
  const list = createMemo(() => projectList(rows(), order()));
  const reorder = (id: string, before: string | undefined): void => {
    const value = reordered(
      list().map((p) => p.id),
      id,
      before,
    );
    void shell.client.commands.run(setSetting, { peer: home, key: PROJECT_ORDER, value }).catch(() => undefined);
  };
  return { list, reorder };
}
