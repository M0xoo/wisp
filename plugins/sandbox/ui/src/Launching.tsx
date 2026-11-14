// What `/sandbox …` opens at once (ADR-0047, v1's placeholder card): the task's first line, the Sandbox pill in the
// machine pill's slot from the first frame, and how it's going while the grid makes the sandbox, the project goes
// in and the task starts there. Then the task itself opens; a refusal says why (the shell's toast too).
import { Show, createSignal, onMount, type JSX } from 'solid-js';
import { entityKey, type PeerId, type PluginClient } from '@wisp/client';
import { Button, Callout, Icon, Inline, Pill, Skeleton, Stack, Text } from '@wisp/ui';
import { launch, type LaunchArgs } from './commands.ts';
import { t } from './i18n.ts';
import type { LaunchingParams } from './views.ts';

/** one launch per id, so the view shown again (a reload, Back) doesn't make a second sandbox */
const started = new Map<string, Promise<{ peer: string; task: string }>>();

export default function Launching(props: { readonly client: PluginClient; readonly params: LaunchingParams }): JSX.Element {
  const c = props.client;
  const [error, setError] = createSignal<string | undefined>(undefined);
  const title = (): string =>
    props.params.prompt
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 64) ?? '';
  onMount(() => {
    const p = props.params;
    let run = started.get(p.id);
    if (!run) {
      const args = { prompt: p.prompt, ...p.launch } as LaunchArgs;
      run = c.run(launch, { peer: c.home as PeerId, args });
      started.set(p.id, run);
    }
    run.then(
      (r) => c.navigate({ t: 'openTask', id: entityKey(r.peer as PeerId, r.task) as never }),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  });
  return (
    <Stack gap="4" pad="6" part="sandbox.launching">
      <Inline gap="2">
        <Text weight="semibold" size="lg" truncate>
          {title()}
        </Text>
        <Pill tone="neutral" variant="outline" part="sandbox.pill">
          <Inline gap="1">
            <Icon name="box" size="sm" />
            {t('sandbox.pill')}
          </Inline>
        </Pill>
      </Inline>
      <Show
        when={error()}
        fallback={
          <Stack gap="2">
            <Text size="sm" tone="muted">
              {t('sandbox.launching')}
            </Text>
            <Skeleton width="full" />
            <Skeleton width="1/2" />
          </Stack>
        }
      >
        {(e) => (
          <Stack gap="3">
            <Callout tone="bad" title={e()} part="sandbox.launching.error" />
            <span>
              <Button size="sm" variant="secondary" icon="back" onClick={() => c.navigate({ t: 'home' })}>
                {t('sandbox.back')}
              </Button>
            </span>
          </Stack>
        )}
      </Show>
    </Stack>
  );
}
