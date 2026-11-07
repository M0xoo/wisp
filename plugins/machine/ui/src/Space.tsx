// Free up space (design/machine-page.md §4) and the harnesses' own folders (design/machine.md
// "Harness data"): the reclaim groups safest first. Review opens Settings → Worktrees, Remove sends
// the group's ids (asking first for the folders no task knows). Harness folders hold sign-ins:
// only the removable files (crash dumps, stale temp files) go, and each harness says how to keep
// less with its own CLI.

import type { PluginClient } from '@wisp/client';
import { Button, Each, Section, Text, UsageList, UsageRow, UsageSkeleton } from '@wisp/ui';
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { machineCommands } from './commands.ts';
import type { MachineData } from './data.ts';
import type { Host } from './host.ts';
import type { HarnessGroup } from './types.ts';
import { reclaimRows, size, type ReclaimRow } from './view.ts';

interface Props {
  readonly client: PluginClient;
  readonly host: Host;
  readonly data: MachineData;
  readonly confirm: (o: { title: string; body: string; ok: string; run: () => void }) => void;
  /** Settings → Worktrees (with the Left over filter for folders no task knows) */
  readonly review: (filter: 'all' | 'left') => void;
}

export function FreeUp(props: Props): JSX.Element {
  const t = props.client.t;
  const cmds = machineCommands(props.data.peer);
  const groups = createMemo(() => reclaimRows(props.data.snap(), t));
  const sum = createMemo(() => groups().reduce((n, g) => n + g.bytes, 0));
  const remove = (g: ReclaimRow): void => {
    const run = (): void => void props.client.run(cmds.clean, g.kind === 'leftover' ? { leftovers: g.ids } : { ids: g.ids }).catch(() => {});
    if (g.safe) return run();
    props.confirm({ title: t('machine.free.confirmTitle', { label: g.label }), body: t('machine.free.confirmBody'), ok: t('machine.act.remove'), run });
  };
  const next = (): string => {
    const days = props.data.snap()?.cleanup ?? '7';
    return days === 'off' ? t('machine.free.off') : t('machine.free.next', { days });
  };
  return (
    <Section title={t('machine.free.title')} description={props.data.snap() ? (groups().length ? t('machine.free.sum', { size: size(sum()) }) : t('machine.free.nothing')) : ''} part="machine.freeUp">
      <UsageList>
        <Show when={props.data.snap()} fallback={<For each={[0, 1]}>{() => <UsageSkeleton cols={1} />}</For>}>
          <Each items={groups()} key={(g) => g.key}>
            {(g) => (
              <UsageRow
                title={g().label}
                sub={g().safe ? t('machine.free.safe') : t('machine.free.unsafe')}
                cells={[{ label: t('machine.col.folder'), value: size(g().bytes) }]}
                actions={
                  <>
                    <Button variant="ghost" size="xs" onClick={() => props.review(g().kind === 'leftover' ? 'left' : 'all')}>
                      {t('machine.act.review')}
                    </Button>
                    <Button variant="ghost" size="xs" {...(!g().safe && { tone: 'bad' as const })} onClick={() => remove(g())}>
                      {t('machine.act.remove')}
                    </Button>
                  </>
                }
              />
            )}
          </Each>
        </Show>
      </UsageList>
      <Text as="p" tone="muted" size="xs">
        {next()}
      </Text>
    </Section>
  );
}

export function HarnessData(props: Props): JSX.Element {
  const t = props.client.t;
  const cmds = machineCommands(props.data.peer);
  const [busy, setBusy] = createSignal(false);
  const group = createMemo(() => props.data.snap()?.reclaim.find((g): g is HarnessGroup => g.kind === 'harness'));
  const clean = async (ids?: readonly string[]): Promise<void> => {
    setBusy(true);
    try {
      const r = await props.client.run(cmds.harnessClean, ids ? { ids } : {});
      props.host.toast.success(t('machine.harness.removable', { size: size(r.freed) }));
    } catch {
      // refused: the runner's toast says why
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={group()}>
      {(g) => (
        <Section
          title={t('machine.harness.title')}
          description={t('machine.harness.desc', { size: size(g().total) })}
          part="machine.harness"
          actions={
            <Show when={g().bytes > 0}>
              <Button variant="ghost" size="sm" loading={busy()} onClick={() => void clean()}>
                {t('machine.act.remove')}
              </Button>
            </Show>
          }
        >
          <UsageList>
            <Each items={g().harnesses} key={(h) => h.id}>
              {(h) => (
                <UsageRow
                  title={h().name}
                  sub={h().removable.bytes > 0 ? t('machine.harness.removable', { size: size(h().removable.bytes) }) : h().how || t('machine.harness.nothing')}
                  cells={[{ label: t('machine.col.folder'), value: size(h().bytes) }]}
                  actions={
                    <Show when={h().removable.bytes > 0}>
                      <Button variant="ghost" size="xs" loading={busy()} onClick={() => void clean([h().id])}>
                        {t('machine.act.remove')}
                      </Button>
                    </Show>
                  }
                />
              )}
            </Each>
          </UsageList>
        </Section>
      )}
    </Show>
  );
}
