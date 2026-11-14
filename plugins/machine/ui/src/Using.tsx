// What's using it, and Left behind (design/machine-page.md §2, §3): rows keyed by what they are,
// so a refresh rewrites only a changed row and moves nothing (v1 fill()); fixed RAM / CPU / Folder
// columns. Stop goes at once (the command's patch hides the row) and comes back with a toast when
// the peer refuses; Later stops, then schedules the carry-on.

import { entityKey, type PluginClient } from '@wisp/client';
import { Button, Each, Menu, Section, Text, UsageHead, UsageList, UsageRow, UsageSkeleton } from '@wisp/ui';
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { machineCommands, stopTask } from './commands.ts';
import type { MachineData } from './data.ts';
import type { Host } from './host.ts';
import { clock, laterChoices, pctText, size, stopAsk, usingRows, wispRow, type UsingRow } from './view.ts';

interface Props {
  readonly client: PluginClient;
  readonly host: Host;
  readonly data: MachineData;
  /** asks before something that can't be undone */
  readonly confirm: (o: { title: string; body: string; ok: string; run: () => void }) => void;
}

function sub(t: PluginClient['t'], x: UsingRow): string {
  if (x.kind === 'wisp') return t('machine.using.self');
  if (x.kind === 'crew') return t('machine.using.jobs', { count: x.ids.length });
  return t('machine.using.procs', { count: Math.max(1, x.procs) });
}

export function Using(props: Props): JSX.Element {
  const t = props.client.t;
  const cmds = machineCommands(props.data.peer);
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const mark = (k: string, on: boolean): void => {
    const next = new Set(busy());
    if (on) next.add(k);
    else next.delete(k);
    setBusy(next);
  };
  const rows = createMemo(() => usingRows(props.data.snap(), t));
  const all = createMemo(() => {
    const m = props.data.snap();
    return m ? [...rows(), wispRow(m)] : [];
  });
  const stop = (x: UsingRow): Promise<unknown> => Promise.all(x.ids.map((id) => props.client.run(stopTask, { id: entityKey(props.data.peer, id) })));
  const later = async (x: UsingRow, at: number): Promise<void> => {
    mark(x.key, true);
    try {
      await stop(x);
      await Promise.all(x.ids.map((id) => props.client.run(cmds.later, { sessionId: id, text: t('machine.later.text'), at })));
      props.host.toast.success(t(x.kind === 'crew' ? 'machine.later.doneCrew' : 'machine.later.done', { at: clock(at, props.host.now()) }));
    } catch {
      // the refusal's toast came from the command runner; the row comes back with the rollback
    } finally {
      mark(x.key, false);
    }
  };
  // Stop is hard to take back: it asks first, here as on the task (v1 #781); Later stops it now too, so it asks as well
  const askStop = (x: UsingRow): void => props.confirm({ ...stopAsk(x, t), ok: t('machine.act.stop'), run: () => void stop(x).catch(() => {}) });
  const askLater = (x: UsingRow, at: number): void => props.confirm({ ...stopAsk(x, t, clock(at, props.host.now())), ok: t('machine.act.stop'), run: () => void later(x, at) });
  const actions = (x: UsingRow): JSX.Element => (
    <Show when={x.kind !== 'wisp'}>
      <Menu
        trigger={{ label: t('machine.act.later'), variant: 'ghost', size: 'xs' }}
        items={laterChoices(props.data.now(), t).map((c) => ({ value: String(c.at), label: c.label }))}
        onSelect={(v) => askLater(x, Number(v))}
      />
      <Button variant="ghost" size="xs" tone="bad" loading={busy().has(x.key)} onClick={() => askStop(x)}>
        {t('machine.act.stop')}
      </Button>
    </Show>
  );
  const cells = (x: UsingRow): { label: string; value: string }[] => [
    { label: t('machine.col.ram'), value: size(x.rss) },
    { label: t('machine.col.cpu'), value: pctText(x.cpu) },
    { label: t('machine.col.folder'), value: x.bytes === null ? '' : size(x.bytes) },
  ];
  return (
    <Section title={t('machine.using.title')} description={t('machine.using.desc')} part="machine.using">
      <UsageList>
        <UsageHead labels={[t('machine.col.ram'), t('machine.col.cpu'), t('machine.col.folder')]} />
        <Show when={props.data.snap()} fallback={<For each={[0, 1, 2]}>{() => <UsageSkeleton cols={3} />}</For>}>
          <Show when={rows().length === 0}>
            <Text as="p" tone="muted" size="sm">
              {t('machine.using.none')}
            </Text>
          </Show>
          <Each items={all()} key={(x) => x.key}>
            {(x) => (
              <UsageRow
                title={x().title}
                sub={sub(t, x())}
                cells={cells(x())}
                busy={busy().has(x().key)}
                actions={actions(x())}
                {...(x().kind === 'task' && { onOpen: () => props.host.navigate({ t: 'openTask', id: entityKey(props.data.peer, x().id) as never }) })}
              />
            )}
          </Each>
        </Show>
      </UsageList>
    </Section>
  );
}

export function LeftBehind(props: Props): JSX.Element {
  const t = props.client.t;
  const cmds = machineCommands(props.data.peer);
  const left = createMemo(() => props.data.snap()?.leftovers ?? []);
  const groups = createMemo(() => props.data.snap()?.leftover_groups ?? []);
  const kill = (pids: readonly number[]): void => {
    for (const pid of pids) void props.client.run(cmds.stopPid, { pid }).catch(() => {});
  };
  const stopAll = (): void =>
    props.confirm({ title: t('machine.left.confirmTitle', { count: left().length }), body: t('machine.left.confirmBody'), ok: t('machine.act.stopAll'), run: () => kill(left().map((p) => p.pid)) });
  const fix = (id: string, command: string): void => {
    void props.client
      .run(cmds.fix, { group: id })
      .then(() => props.host.toast.success(t('machine.left.fixed', { command })))
      .catch(() => {});
  };
  const from = (task: string | null): string => {
    if (!task) return t('machine.left.noTask');
    const row = props.client.entities.peek<{ title?: string }>('session', entityKey(props.data.peer, task));
    return t('machine.left.from', { task: row?.title || t('machine.left.finished') });
  };
  return (
    <Show when={left().length > 0}>
      <Section
        title={t('machine.left.title')}
        description={t('machine.left.desc')}
        part="machine.leftBehind"
        actions={
          <Button variant="ghost" size="sm" tone="bad" onClick={stopAll}>
            {t('machine.act.stopAll')}
          </Button>
        }
      >
        <UsageList>
          <Each items={left()} key={(p) => String(p.pid)}>
            {(row) => {
              const group = (): { id: string; command: string } | undefined => groups().find((g) => g.pids.includes(row().pid));
              return (
                <UsageRow
                  title={row().command}
                  mono
                  sub={t('machine.left.meta', { from: from(row().task), age: ageOf(row().since, props.data.now()), pid: row().pid })}
                  cells={[{ label: t('machine.col.ram'), value: size(row().rss) }]}
                  actions={
                    <>
                      <Show when={group()}>
                        {(g) => (
                          <Button variant="ghost" size="xs" onClick={() => fix(g().id, g().command)}>
                            {t('machine.act.fix')}
                          </Button>
                        )}
                      </Show>
                      <Button variant="ghost" size="xs" tone="bad" onClick={() => kill([row().pid])}>
                        {t('machine.act.stop')}
                      </Button>
                    </>
                  }
                />
              );
            }}
          </Each>
        </UsageList>
      </Section>
    </Show>
  );
}

/** 3m, 2h, 4d: how old a process is */
function ageOf(since: number, now: number): string {
  const m = Math.max(1, Math.round((now - since) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}
