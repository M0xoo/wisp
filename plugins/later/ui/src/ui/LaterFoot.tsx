// `wisp.later.foot`, over the task's reply box (`shell.task:foot`): the follow-ups set for later in this task (v1
// later.js followUpItems), soonest first, each with when it goes and who set it (At 14:45 · set by you), Send now
// and Cancel. A follow-up typed with a time in the reply box (F-auto-5) appears here at once: `later.add`'s patch.
import { Show, createMemo, type JSX } from 'solid-js';
import { Key } from '@zag-js/solid';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { IconButton, Inline, ListRow, Stack, useSignal } from '@wisp/ui';
import { cancelFollowUp, editFollowUp } from '../commands.ts';
import { followUpTag } from '../format.ts';
import { t } from '../i18n.ts';
import { KIND, type LaterView, type SessionRow } from '../types.ts';
import { sortLater } from '../rules.ts';

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
  return (
    <Show when={list().length > 0}>
      <Stack gap="1" part="later.foot" role="list" aria-label={t('wisp.later.foot.label')}>
        <Key each={list()} by={(l) => l.id}>
          {(l) => (
            <ListRow
              part="later.foot.row"
              quiet
              title={l().text}
              sub={followUpTag(l(), Date.now())}
              actions={
                <Inline gap="1">
                  <Show when={!l().goal}>
                    <IconButton icon="send" size="xs" label={t(l().remind ? 'wisp.later.menu.remindNow' : 'wisp.later.menu.sendNow')} onClick={() => run(c.run(editFollowUp, { sessionId: key() ?? '', item: l().id, now: true }))} />
                  </Show>
                  <IconButton icon="x" size="xs" label={t(l().remind ? 'wisp.later.menu.cancelReminder' : 'wisp.later.menu.cancelFollowUp')} onClick={() => run(c.run(cancelFollowUp, { sessionId: key() ?? '', item: l().id }))} />
                </Inline>
              }
            />
          )}
        </Key>
      </Stack>
    </Show>
  );
}
