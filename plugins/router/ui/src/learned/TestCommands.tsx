// Tests per project: the command the scout hands the agent and a goal check runs. Saved on blur or
// Enter; shown at once, put back if the peer refuses.

import { For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Heading, Input, ListRow, Stack, Text } from '@wisp/ui';
import { projectTests } from '../commands.ts';
import { toastOf } from '../host.ts';
import { t } from '../i18n.ts';
import type { ProjectTests } from '../types.ts';

const placeholder = (p: ProjectTests): string =>
  p.detected?.command ?? (p.detected?.skip ? t('wisp.router.learned.tests-skip', { why: p.detected.skip }) : t('wisp.router.learned.tests-none-found'));

function TestInput(props: { readonly client: PluginClient; readonly project: ProjectTests }): JSX.Element {
  const save = (value: string): void => {
    const v = value.trim();
    if (v === props.project.testCommand) return;
    props.client
      .run(projectTests, { peer: props.client.home, id: props.project.id, testCommand: v })
      .then(() => toastOf(props.client)?.show(v ? t('wisp.router.learned.tests-saved', { command: v }) : t('wisp.router.learned.tests-cleared'), { tone: 'success' }))
      .catch(() => {});
  };
  return (
    <Input
      size="sm"
      mono
      spellcheck={false}
      aria-label={props.project.name}
      value={props.project.testCommand}
      placeholder={placeholder(props.project)}
      onBlur={(e) => save((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

export function TestCommands(props: { readonly client: PluginClient; readonly projects: readonly ProjectTests[] }): JSX.Element {
  return (
    <Stack gap="2" part="router.tests">
      <Heading level={4} size="sm">
        {t('wisp.router.learned.tests')}
      </Heading>
      <Text size="sm" tone="muted" as="p">
        {t('wisp.router.learned.tests-hint')}
      </Text>
      <Show when={props.projects.length > 0} fallback={<Text tone="muted">{t('wisp.router.learned.tests-empty')}</Text>}>
        <Stack gap="1">
          <For each={props.projects}>{(p) => <ListRow part="router.test" title={p.name} actions={<TestInput client={props.client} project={p} />} />}</For>
        </Stack>
      </Show>
    </Stack>
  );
}
