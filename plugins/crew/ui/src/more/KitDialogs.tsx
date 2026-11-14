// The kit's two dialogs (v1 crew-kit.js importDialog, generateDialog): pick files already on this computer (wisp's
// skills, the project's AGENTS.md) to copy into the kit; or have the member build its own, a job whose proposal
// shows under it in the thread. Both close at once; the parent saves.

import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { uuidv7, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, CrewPickList, Dialog, Field, Inline, Stack, Text, TextArea, Wrap } from '@wisp/ui';
import { assignJob } from '../commands.ts';
import type { CrewMember } from '../data.ts';
import { t } from '../i18n.ts';
import { localKit } from './commands.ts';
import { fitsKit } from './kit-logic.ts';
import { ideas, kitGoal, localRows, type Say } from './kit-view.ts';
import { KIT_MAX } from './skill-md.ts';
import type { KitDraft } from './types.ts';

const say = t as unknown as Say;

export function LocalKitPicker(props: { readonly client: PluginClient; readonly member: () => CrewMember; readonly onAdd: (drafts: KitDraft[]) => void; readonly onClose: () => void }): JSX.Element {
  const shell = useShell();
  const m = props.member;
  // its project's AGENTS.md too, when it works here (a member on another machine reads that machine's)
  const [files] = createResource(() => props.client.run(localKit, { key: m().key, ...(m().cwd && !m().machine && { cwd: m().cwd }) }));
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const rows = () => localRows(m().kit ?? [], files() ?? []);
  const group = (kind: 'skill' | 'rules') =>
    rows()
      .filter((r) => r.draft.kind === kind)
      .map((r) => ({ key: r.key, kind, name: r.draft.name, description: r.draft.description, from: r.from, picked: picked().has(r.key), added: r.added, pill: r.added ? t('wisp.crew.more.local.added') : undefined }));
  const pick = (key: string, on: boolean): void => {
    const next = new Set(picked());
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const add = (): void => {
    const drafts = rows()
      .filter((r) => picked().has(r.key))
      .map((r) => r.draft);
    if (!fitsKit((m().kit ?? []).length, drafts.length)) return void shell.toast.error(say('wisp.crew.more.local.tooMany', { n: KIT_MAX }));
    props.onAdd(drafts);
  };
  return (
    <Dialog
      part="crew.kitLocal"
      open
      size="md"
      title={say('wisp.crew.more.local.title', { name: m().name })}
      description={t('wisp.crew.more.local.hint')}
      onOpenChange={(o) => !o && props.onClose()}
      footer={
        <Inline gap="2" justify="end">
          <Button variant="ghost" size="sm" onClick={() => props.onClose()}>
            {t('wisp.crew.more.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={!picked().size} onClick={add}>
            {picked().size ? say('wisp.crew.more.local.addN', { n: picked().size }) : t('wisp.crew.more.add')}
          </Button>
        </Inline>
      }
    >
      <Show when={!files.error} fallback={<Text tone="muted">{say('wisp.crew.more.local.failed', { why: String((files.error as Error | undefined)?.message ?? files.error) })}</Text>}>
        <Stack gap="3">
          <CrewPickList title={t('wisp.crew.more.local.skills')} rows={group('skill')} loading={files.loading} empty={t('wisp.crew.more.local.noSkills')} onPick={pick} />
          <Show when={!files.loading}>
            <CrewPickList title={t('wisp.crew.more.local.rules')} rows={group('rules')} empty={t('wisp.crew.more.local.noRules')} onPick={pick} />
          </Show>
        </Stack>
      </Show>
    </Dialog>
  );
}

/** Have them build their kit (v1 generateDialog): a goal, a few ideas, Start. Refused, it opens again. */
export function GenerateKit(props: { readonly client: PluginClient; readonly member: () => CrewMember; readonly onClose: () => void; readonly onRestore: () => void }): JSX.Element {
  const m = props.member;
  const [goal, setGoal] = createSignal('');
  const list = (): string[] => ideas(m(), say);
  const start = (): void => {
    const prompt = kitGoal(goal(), list()[0] ?? '');
    props.onClose();
    props.client
      .run(assignJob, { key: m().key, crewId: m().id, job: uuidv7(), prompt, title: prompt.split('\n')[0]?.slice(0, 80) ?? prompt, kit: true })
      .catch(() => props.onRestore());
  };
  return (
    <Dialog
      part="crew.kitGenerate"
      open
      size="md"
      title={say('wisp.crew.more.gen.title', { name: m().name })}
      onOpenChange={(o) => !o && props.onClose()}
      footer={
        <Inline gap="2" justify="end">
          <Button variant="ghost" size="sm" onClick={() => props.onClose()}>
            {t('wisp.crew.more.cancel')}
          </Button>
          <Button variant="primary" size="sm" icon="wizard" onClick={start}>
            {t('wisp.crew.more.gen.start')}
          </Button>
        </Inline>
      }
    >
      <Stack gap="3">
        <Field label={t('wisp.crew.more.gen.label')}>
          <TextArea value={goal()} minRows={3} maxLength={2000} placeholder={`${list()[0] ?? ''}.`} autofocus onInput={setGoal} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start()} />
        </Field>
        <Wrap gap="2">
          <For each={list()}>
            {(idea) => (
              <Button variant="chip" size="sm" onClick={() => setGoal(`${idea}.`)}>
                {idea}
              </Button>
            )}
          </For>
        </Wrap>
        <Text size="sm" tone="muted">
          {say(m().cwd ? 'wisp.crew.more.gen.hint' : 'wisp.crew.more.gen.hintNoProject', { name: m().name })}
        </Text>
      </Stack>
    </Dialog>
  );
}
