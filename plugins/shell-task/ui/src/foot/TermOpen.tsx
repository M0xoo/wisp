// `shell-task.term-open`: a terminal task (v1 services/tui.js) opens on its terminal. Shown with the task, it opens
// the Terminal pane beside it once, when nothing else is open there; closing the pane keeps it closed.
import { createEffect, createMemo, on, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useSignal } from '@wisp/ui';
import { TERM_VIEW, isTui, keyOf } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { KIND } from '../types.ts';

export default function TermOpen(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const key = (): EntityKey | undefined => {
    const id = props.id ?? props.session?.()?.id;
    return id ? (keyOf(shell.client, id) as EntityKey | undefined) : undefined;
  };
  const row = createMemo(() => {
    const k = key();
    return k ? useSignal(props.client.entities.row<unknown>(KIND.session, k)) : () => undefined;
  });
  const tui = createMemo(() => isTui(row()()));
  createEffect(
    on(tui, (yes) => {
      if (yes && shell.client.nav.nav().side.kind === 'none') shell.navigate({ t: 'openSide', side: { kind: 'view', id: TERM_VIEW as never } });
    }),
  );
  return null;
}
