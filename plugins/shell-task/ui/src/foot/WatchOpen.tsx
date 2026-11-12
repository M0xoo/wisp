// `shell-task.watch-open`: when the agent opens a watch while its task is open (wisp_watch action "open"), the Watch
// tab opens beside it by itself, as v1's panel did on bus 'watch' (opened); the rule is `opensWatch`.
import { createEffect, createMemo, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useSignal } from '@wisp/ui';
import { WATCH_VIEW, keyOf, opensWatch, watchOpened } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { KIND } from '../types.ts';

export default function WatchOpen(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const key = (): EntityKey | undefined => {
    const id = props.id ?? props.session?.()?.id;
    return id ? (keyOf(shell.client, id) as EntityKey | undefined) : undefined;
  };
  const row = createMemo(() => {
    const k = key();
    return k ? useSignal(props.client.entities.row<unknown>(KIND.session, k)) : () => undefined;
  });
  // the mark the task had when it opened (or when its row arrived): only a later open opens the tab
  let seen: number | undefined;
  createEffect(() => {
    const r = row()();
    if (r === undefined) return;
    const now = watchOpened(r);
    const nav = shell.client.nav.nav();
    if (opensWatch(seen, now, nav.side as { kind: string; id?: string }, nav.layout === 'stack')) shell.navigate({ t: 'openSide', side: { kind: 'view', id: WATCH_VIEW as never } });
    seen = now;
  });
  return null;
}
