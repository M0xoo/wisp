// Set goal… / Edit goal… (v1 goal.js editGoal): Done when, the hint, the judges and Save. A new goal
// starts from the launcher's judges; an existing one keeps its own. Save closes at once and the band
// shows the goal; a refusal puts the old one back with the shell's toast. Enter saves, Shift+Enter
// is a new line.

import { createSignal, Show, type JSX } from 'solid-js';
import type { EntityKey, PluginClient } from '@wisp/client';
import { Button, Inline, Stack, Text, TextArea } from '@wisp/ui';
import { setGoal } from './commands.ts';
import { t } from './i18n.ts';
import { JudgesButton } from './Judges.tsx';
import { liveJudges } from './rules.ts';
import { launcherGoal } from './store.ts';
import { bareId, useCrew, useHarnesses, useTask } from './task.ts';
import { MAX_TEXT, type Judge, type Vote } from './types.ts';

export interface EditParams {
  readonly task: string;
}

export function parseEdit(p: unknown): EditParams {
  const o = p as { task?: unknown } | null;
  if (!o || typeof o.task !== 'string' || !o.task.includes(':')) throw new Error('edit goal: task key');
  return { task: o.task };
}

export default function EditGoal(props: { readonly client: PluginClient; readonly params: EditParams }): JSX.Element {
  const key = props.params.task as EntityKey;
  const row = useTask(props.client, () => key);
  const crew = useCrew(props.client);
  const harnesses = useHarnesses(props.client);
  const launcher = launcherGoal(props.client).get();
  const g = row()?.goal;
  const [text, setText] = createSignal(g?.text ?? '');
  const [judges, setJudges] = createSignal<Judge[]>(g ? (g.judges ?? []) : liveJudges(launcher.judges, crew(), harnesses()));
  const [vote, setVote] = createSignal<Vote>((g ? g.vote : launcher.vote) ?? 'majority');
  let box: HTMLTextAreaElement | undefined;
  const close = (): void => props.client.navigate({ t: 'closeOverlay' });
  const save = (): void => {
    const goal = text().trim();
    if (!goal) return void box?.focus();
    close();
    void props.client
      .run(setGoal, { session: key, sessionId: bareId(key), goal: { text: goal, judges: judges(), vote: vote() }, kick: true, now: props.client.scope.timers.now() })
      .catch(() => {});
  };
  return (
    <Stack gap="3" part="goal.edit">
      <Text as="label" for="goal-text" size="sm" weight="medium">
        {t('wisp.goal.doneWhen')}
      </Text>
      <TextArea
        id="goal-text"
        part="goal.editText"
        value={text()}
        minRows={3}
        maxLength={MAX_TEXT}
        spellcheck={false}
        autofocus
        placeholder={t('wisp.goal.placeholderLong')}
        ref={(el) => (box = el)}
        onInput={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      <Text size="sm" tone="muted">
        {t('wisp.goal.hint')}
      </Text>
      <Inline gap="2" justify="between">
        <JudgesButton client={props.client} judges={judges()} vote={vote()} onChange={(j, v) => (setJudges(j), setVote(v))} />
        <Inline gap="2">
          <Button variant="ghost" size="sm" onClick={close}>
            {t('wisp.goal.edit.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={save}>
            <Show when={g} fallback={t('wisp.goal.edit.set')}>
              {t('wisp.goal.edit.save')}
            </Show>
          </Button>
        </Inline>
      </Inline>
    </Stack>
  );
}
