// `wisp.later.foot`, over the task's reply box (`shell.task:foot`): the follow-ups set for later in this task (v1
// later.js followUpItems), soonest first, each with when it goes and who set it (At 14:45 · set by you), Send now
// and Cancel. A follow-up typed with a time in the reply box (F-auto-5) appears here at once: `later.add`'s patch.
// Before it goes it can be changed (F-auto-7, v1 0.49.0): the pen (or a click on the row) edits its text in place,
// Enter keeps it, Escape leaves it as it was; the clock is Change time… (v1's row menu).
import { Show, createMemo, createSignal, type JSX } from 'solid-js';
import { Key } from '@zag-js/solid';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { IconButton, Inline, ListRow, Stack, TextArea, useSignal } from '@wisp/ui';
import { cancelFollowUp, editFollowUp, editedText } from '../commands.ts';
import { TimeMenu } from './TimeMenu.tsx';
import { followUpTag } from '../format.ts';
import { t } from '../i18n.ts';
import { KIND, type LaterView, type SessionRow } from '../types.ts';
import { sortLater } from '../rules.ts';

/** The text in place: Enter or leaving it keeps it, Escape leaves the follow-up as it was. */
function EditBox(p: { readonly text: string; readonly label: string; readonly onDone: (text: string | undefined) => void }): JSX.Element {
  const [v, setV] = createSignal(p.text);
  const done = { sent: false };
  const finish = (text: string | undefined): void => {
    if (done.sent) return;
    done.sent = true;
    p.onDone(text);
  };
  return (
    <TextArea
      aria-label={p.label}
      value={v()}
      onInput={setV}
      autofocus
      minRows={1}
      maxRows={8}
      onBlur={() => finish(v())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(undefined);
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          finish(v());
        }
      }}
    />
  );
}

export default function LaterFoot(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const key = (): EntityKey | undefined => (props.id ?? props.session?.()?.id) as EntityKey | undefined;
  type Row = SessionRow & { body?: { ext?: Record<string, { later?: LaterView[] } | undefined> } };
  const row = createMemo(() => {
    const k = key();
    return k ? useSignal(c.entities.row<Row>(KIND.session, k)) : () => undefined;
  });
  // the flat list (v1's row, and later.add's patch), else what wisp.later keeps in the task's ext slot
  const list = (): LaterView[] => sortLater(row()()?.later ?? row()()?.body?.ext?.['wisp.later']?.later ?? []);
  const run = (p: Promise<unknown>): void => void p.catch(() => undefined); // the shell's onError shows the rollback toast
  const [editing, setEditing] = createSignal<string | undefined>(undefined);
  // a goal's round and a row not yet saved (its tmp id) aren't edited (v1 followUpItems)
  const editable = (l: LaterView): boolean => !l.goal && !l.id.startsWith('tmp');
  const editLabel = (l: LaterView): string => t(l.remind ? 'wisp.later.menu.editReminder' : 'wisp.later.menu.editFollowUp');
  return (
    <Show when={list().length > 0}>
      <Stack gap="1" part="later.foot" role="list" aria-label={t('wisp.later.foot.label')}>
        <Key each={list()} by={(l) => l.id}>
          {(l) => (
            <Show
              when={editing() !== l().id}
              fallback={
                <EditBox
                  text={l().text}
                  label={editLabel(l())}
                  onDone={(text) => {
                    setEditing(undefined);
                    const next = editedText(l().text, text);
                    if (next !== undefined) run(c.run(editFollowUp, { sessionId: key() ?? '', item: l().id, text: next }));
                  }}
                />
              }
            >
              <ListRow
                part="later.foot.row"
                quiet
                title={l().text}
                sub={followUpTag(l(), Date.now())}
                {...(editable(l()) && { onOpen: () => setEditing(l().id) })}
                actions={
                  <Inline gap="1">
                    <Show when={!l().goal}>
                      <IconButton icon="send" size="xs" label={t(l().remind ? 'wisp.later.menu.remindNow' : 'wisp.later.menu.sendNow')} onClick={() => run(c.run(editFollowUp, { sessionId: key() ?? '', item: l().id, now: true }))} />
                    </Show>
                    <Show when={editable(l())}>
                      <IconButton icon="pen" size="xs" label={editLabel(l())} onClick={() => setEditing(l().id)} />
                      <TimeMenu
                        client={c}
                        part="later.foot.time"
                        trigger={{ icon: 'clock', 'aria-label': t('wisp.later.menu.changeTime'), size: 'xs' }}
                        onPick={(at) => run(c.run(editFollowUp, { sessionId: key() ?? '', item: l().id, at }))}
                      />
                    </Show>
                    <IconButton icon="x" size="xs" label={t(l().remind ? 'wisp.later.menu.cancelReminder' : 'wisp.later.menu.cancelFollowUp')} onClick={() => run(c.run(cancelFollowUp, { sessionId: key() ?? '', item: l().id }))} />
                  </Inline>
                }
              />
            </Show>
          )}
        </Key>
      </Stack>
    </Show>
  );
}
