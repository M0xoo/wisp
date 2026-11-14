// `shell-composer.queue`, over the task's reply box (`shell.task:foot`): the follow-ups waiting for the run
// (v1 queued.js), each with when it goes, Send now, Edit, Combine with the next, Move, and Cancel. The queue is
// the task's row (`body.queue`, `body.queueHeld`); every change is a command whose patch shows it at once.
import { Show, createMemo, createSignal, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Dialog, Inline, useSignal } from '@wisp/ui';
import { queueCancel, queueEdit, queueMerge, queueNow, queueOrder } from '../commands.ts';
import { envOf } from '../env.ts';
import { KIND, type QueueItem, type Row } from '../types.ts';
import { QueueList } from './QueueList.tsx';
import { useShell as useShellContext } from '@wisp/shell';

interface TaskBody {
  readonly queue?: readonly Row<QueueItem>[];
  readonly queueHeld?: boolean;
  readonly agent?: string;
  readonly state?: string;
}

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

export default function QueueFoot(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const env = envOf(c);
  // the task the slot is for: its id, or the row it lends (as the other `shell.task:foot` extensions read it)
  const key = (): EntityKey | undefined => (props.id ?? (props.session?.() as { id?: string } | undefined)?.id) as EntityKey | undefined;
  const row = createMemo(() => {
    const k = key();
    return k ? useSignal(c.entities.row<{ state?: string; agent?: string; body?: TaskBody }>(KIND.session, k)) : () => undefined;
  });
  const body = (): TaskBody => row()()?.body ?? {};
  const queue = (): readonly Row<QueueItem>[] => body().queue ?? [];
  // the harness as it calls itself (v1: "after Claude Code finishes"), from the harness plugins' registrations
  const harnesses = useSignal(useShellContext().harnesses());
  const harnessName = (id: string): string => harnesses().find((h) => h.id === id)?.name ?? id;
  const [asking, setAsking] = createSignal<{ text: string; answer: (yes: boolean) => void } | undefined>();
  const confirm = (text: string): Promise<boolean> =>
    new Promise((resolve) =>
      setAsking({
        text,
        answer: (yes) => {
          setAsking(undefined);
          resolve(yes);
        },
      }),
    );
  const run = (f: (k: EntityKey) => Promise<unknown>): void => {
    const k = key();
    if (k) quiet(f(k));
  };
  return (
    <Show when={queue().length > 0}>
      <Show when={asking()}>
        {(a) => (
          <Dialog
            open
            role="alertdialog"
            size="sm"
            title={a().text}
            onOpenChange={(o) => !o && a().answer(false)}
            part="shell-composer.queue.confirm"
            footer={
              <Inline gap="3" justify="end">
                <Button size="sm" variant="ghost" onClick={() => a().answer(false)}>
                  {env.t('shell-composer.queue.keep')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => a().answer(true)}>
                  {env.t('shell-composer.queue.cancel')}
                </Button>
              </Inline>
            }
          />
        )}
      </Show>
      <QueueList
        env={env}
        queue={queue()}
        held={body().queueHeld === true}
        running={(row()()?.state ?? body().state) === 'running'}
        name={harnessName(row()()?.agent ?? body().agent ?? '')}
        confirm={confirm}
        refocus={() => undefined}
        actions={{
          now: (id) => run((k) => c.run(queueNow, { session: k, item: id })),
          edit: (id, text) => run((k) => c.run(queueEdit, { session: k, item: id, text })),
          merge: (ids) => run((k) => c.run(queueMerge, { session: k, items: ids })),
          order: (ids) => run((k) => c.run(queueOrder, { session: k, order: ids })),
          cancel: (id) => run((k) => c.run(queueCancel, { session: k, item: id })),
        }}
      />
    </Show>
  );
}
