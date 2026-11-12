// Rerun… (v1 actions.js rerunDialog, F-task-43/44): the task's prompt to edit, where it runs (another computer, when
// there are others), its mode and harness, then Rerun: a new task from this one's spec (`rerun.ts`); the old one stays.
import { Show, createResource, createSignal, type JSX } from 'solid-js';
import { entityKey, ownerOf, uuidv7, type EntityKey, type PeerId } from '@wisp/client';
import { AutoRunner, Button, Inline, Select, Stack, Text, TextArea, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { create, specOf } from './commands.ts';
import { harnessOf } from './harness.ts';
import { RunnerPicker } from './RunnerPicker.tsx';
import { rerunArgs, startEdits, type RerunEdits } from './rerun.ts';

export default function Rerun(props: { readonly params: { readonly id: string; readonly agent?: string } }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const key = props.params.id as EntityKey;
  const peer = ownerOf(key);
  const row = useSignal(shell.client.entities.row<SessionRow>(SESSION, key));
  const harnesses = useSignal(shell.harnesses());
  const peers = useSignal(shell.client.peers.list());
  const [spec] = createResource(() => shell.client.commands.run(specOf, { id: key }));
  const [edits, setEdits] = createSignal<RerunEdits | undefined>();
  const e = (): RerunEdits | undefined => edits() ?? (spec() ? startEdits(spec() as never, peer, props.params.agent) : undefined);
  const set = (p: Partial<RerunEdits>): void => {
    const cur = e();
    if (cur) setEdits({ ...cur, ...p });
  };
  const [picking, setPicking] = createSignal(false);
  const go = (): void => {
    const s = spec();
    const x = e();
    if (!s || !x?.prompt.trim()) return;
    const id = entityKey(x.peer as PeerId, uuidv7());
    void shell.client.commands.run(create, rerunArgs(s as never, x, { of: key, id, at: Date.now() }) as never).catch(() => undefined);
    shell.navigate({ t: 'closeOverlay', id: 'shell.rerun' as never });
    shell.navigate({ t: 'openTask', id: id as never });
  };
  return (
    <Show when={e()} fallback={<Text tone="muted">{t('shell.rerun.loading')}</Text>}>
      {(x) => (
        <Stack gap="4" part="rerun.body">
          <TextArea value={x().prompt} onInput={(v) => set({ prompt: v })} minRows={3} maxRows={12} spellcheck={false} aria-label={t('shell.rerun.prompt')} />
          <Inline gap="2" align="center" part="rerun.bar">
            <Show when={peers().length > 1}>
              <Select
                aria-label={t('shell.rerun.where')}
                value={x().peer}
                onChange={(v) => set({ peer: v })}
                items={peers().map((p) => ({ value: p, label: p === peer ? t('shell.rerun.here', { name: shell.client.peers.name(p) }) : shell.client.peers.name(p) }))}
              />
            </Show>
            <Select aria-label={t('shell.rerun.mode')} value={x().mode} onChange={(v) => set({ mode: v })} items={['plan', 'edits', 'auto'].map((m) => ({ value: m, label: t(`shell.mode.${m}`) }))} />
            <AutoRunner
              harness={x().agent ? harnessOf(harnesses(), x().agent).name : t('shell.rerun.auto')}
              model={x().model || undefined}
              logo={harnessOf(harnesses(), x().agent).logo}
              title={t('shell.rerun.runner')}
              onClick={() => setPicking(true)}
            />
            <span data-kit="grow" />
            <Button variant="primary" size="sm" icon="rerun" disabled={!x().prompt.trim()} onClick={go} part="rerun.go">
              {t('shell.rerun.go')}
            </Button>
          </Inline>
          <Text size="sm" tone="muted">
            {t('shell.rerun.hint', { cwd: (spec() as { cwd?: string } | undefined)?.cwd ?? '', where: shell.client.peers.name(x().peer as PeerId), title: row()?.title ?? '' })}
          </Text>
          <RunnerPicker
            open={picking()}
            onOpenChange={setPicking}
            peer={x().peer}
            value={{ agent: x().agent, model: x().model, effort: x().effort }}
            onChange={(r) => set({ agent: r.agent, model: r.model, effort: r.effort })}
          />
        </Stack>
      )}
    </Show>
  );
}
