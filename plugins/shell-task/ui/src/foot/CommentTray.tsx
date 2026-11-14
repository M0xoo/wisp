// `shell-task.comments`: over the reply box, the comments (on lines of Changes, on answers) waiting for the next follow-up (v1 comments.js
// tray): how many, Send comments (they go alone), and a row each with its number, its words, where, and ×.
import { createMemo, type JSX } from 'solid-js';
import { entityKey, uuidv7, type EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { CommentTray as Tray, useSignal } from '@wisp/ui';
import { commentStore, isLine, removed, waiting, whereOf, withComments } from '../comments.ts';
import { keyOf } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { followUp } from './send.ts';

export default function CommentTray(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const store = commentStore(props.client);
  const all = useSignal(store.value);
  const key = (): EntityKey | undefined => {
    const id = props.id ?? props.session?.()?.id;
    return id ? (keyOf(shell.client, id) as EntityKey | undefined) : undefined;
  };
  const list = createMemo(() => {
    const k = key();
    return k ? waiting(all(), k) : [];
  });
  // Send comments: they go as the follow-up on their own; back in the tray if it's refused
  const send = (): void => {
    const k = key();
    if (!k || list().length === 0) return;
    const was = all();
    const text = withComments(list(), '');
    store.set((cur) => {
      const next = { ...(cur as Record<string, unknown>) };
      delete next[k];
      return next as never;
    });
    const peer = k.slice(0, k.indexOf(':')) as never;
    props.client
      .run(followUp, { id: k, text, turnId: entityKey(peer, uuidv7()), idx: Number((props.session?.() as { turns?: number } | undefined)?.turns ?? 0), at: Date.now() })
      .catch(() => store.set(was as never));
  };
  return (
    <Tray
      part="comment.tray"
      line={t('shell-task.comment.waiting', { count: list().length })}
      send={{ label: t('shell-task.comment.send'), onClick: send }}
      removeLabel={t('shell-task.comment.remove')}
      items={list().map((c, i) => ({ key: isLine(c) ? `${c.file}:${c.side}:${c.line}` : (c.id ?? `${c.turn}:${c.i}:${i}`), say: c.note, where: whereOf(c), onRemove: () => key() && store.set((cur) => removed(cur, key() as string, i) as never) }))}
    />
  );
}
