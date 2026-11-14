// The lead's team in the panel beside the task (v1 team.js: the live line per delegate, then its report), F-crew-11:
// every crew job this task handed out, delegated or tagged, each row a member's face, @name, what it's doing or came
// back with, and its state; a click opens the job, a task of its own. A sideTabs pane: its tab shows only while the
// task has such jobs (index.ts).
import { createMemo, For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Face, ListRow, Pill, Stack, Text, useSignal } from '@wisp/ui';
import { crewData } from './data.ts';
import { t } from './i18n.ts';
import { teamRows, type Say } from './team.ts';

export default function TeamPane(props: { readonly client: PluginClient; readonly task: string; readonly value: string }): JSX.Element {
  const c = props.client;
  const say = t as unknown as Say;
  const data = crewData(c);
  const jobs = useSignal(data.jobs);
  const members = useSignal(data.members);
  const rows = createMemo(() => teamRows(jobs(), props.task, (id) => members().find((m) => m.id === id), say));
  const open = (id: string): void => {
    const key = data.sessionKey(id);
    if (key) c.navigate({ t: 'openTask', id: key as never });
  };
  return (
    <Stack gap="1" part="crew.team">
      <Show when={rows().length} fallback={<Text tone="muted">{t('wisp.crew.team.none')}</Text>}>
        <For each={rows()}>
          {(r) => (
            <ListRow
              part="crew.team.row"
              title={r.handle}
              lead={<Face avatar={r.avatar} name={r.name} color={r.color} size="sm" mood={r.live ? 'live' : 'idle'} />}
              sub={<>{r.line}</>}
              subTone={r.live ? 'accent-ink' : r.tone === 'warn' ? 'warn' : 'muted'}
              pills={
                <Pill tone={r.tone} dot live={r.live} size="sm">
                  {r.status}
                </Pill>
              }
              {...(!r.pending && { onOpen: () => open(r.id) })}
            />
          )}
        </For>
      </Show>
    </Stack>
  );
}
