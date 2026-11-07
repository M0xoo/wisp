// "What Auto learned" (v1 web/js/features/auto.js openRouter): where its numbers start, every
// harness · model · thinking level with Never / Prefer, the per-kind rules from the launcher, each
// project's test command, the recent picks, and Forget. Opened from Settings → Auto.

import { For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Heading, Inline, Link, Skeleton, Stack, Text } from '@wisp/ui';
import { routerSet } from '../commands.ts';
import { useRouterView } from '../data.ts';
import { t } from '../i18n.ts';
import { shownArms, toggleRule, type RuleKind, type RuleSet } from '../rules.ts';
import type { ArmReport, RouterView } from '../types.ts';
import { ArmRow } from './ArmRow.tsx';
import { KindRules } from './KindRules.tsx';
import { RecentPicks } from './RecentPicks.tsx';
import { ResetButton } from './ResetButton.tsx';
import { TestCommands } from './TestCommands.tsx';

const dateOf = (iso: string): string => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

function Sources(props: { readonly view: RouterView }): JSX.Element {
  const list = (): [string, { name: string; url: string; date: string }][] => Object.entries(props.view.priors.sources ?? {});
  return (
    <Show when={list().length > 0}>
      <Stack gap="2" part="router.sources">
        <Heading level={4} size="sm">
          {t('wisp.router.learned.sources')}
        </Heading>
        <For each={list()}>
          {([, s]) => (
            <Inline gap="3" justify="between">
              <Link href={s.url} external>
                {s.name}
              </Link>
              <Text size="sm" tone="muted" nowrap numeric>
                {dateOf(s.date)}
              </Text>
            </Inline>
          )}
        </For>
      </Stack>
    </Show>
  );
}

/** Never / Prefer: on at once, both lists sent whole, put back by the client if the peer refuses. */
function useRules(client: PluginClient, view: () => RouterView | undefined): { rules: () => RuleSet; toggle: (k: RuleKind, a: ArmReport) => void; drop: (rule: string) => void } {
  const rules = (): RuleSet => ({ blocked: view()?.settings.blocked ?? [], prefer: view()?.settings.prefer ?? [] });
  const send = (next: RuleSet): void => void client.run(routerSet, { peer: client.home, patch: { blocked: next.blocked, prefer: next.prefer } }).catch(() => {});
  return {
    rules,
    toggle: (k, a) => send(toggleRule(rules(), k, a)),
    drop: (rule) => send({ ...rules(), blocked: rules().blocked.filter((x) => x !== rule) }),
  };
}

function Body(props: { readonly client: PluginClient; readonly view: RouterView }): JSX.Element {
  const r = useRules(props.client, () => props.view);
  const arms = (): ArmReport[] => shownArms(props.view.arms);
  return (
    <Stack gap="6" part="router.learned">
      <Text tone="muted" size="sm" as="p">
        {t('wisp.router.learned.intro')}
      </Text>
      <Sources view={props.view} />
      <Stack gap="2">
        <Heading level={4} size="sm">
          {t('wisp.router.learned.arms')}
        </Heading>
        <Stack gap="1" part="router.arms" role="list">
          <For each={arms()}>{(a) => <ArmRow arm={a} rules={r.rules()} onToggle={r.toggle} />}</For>
        </Stack>
        <KindRules blocked={r.rules().blocked} arms={arms()} onDrop={r.drop} />
      </Stack>
      <TestCommands client={props.client} projects={props.view.projects} />
      <RecentPicks client={props.client} recent={props.view.recent} />
      <ResetButton client={props.client} />
    </Stack>
  );
}

export default function Learned(props: { readonly client: PluginClient; readonly params?: unknown }): JSX.Element {
  const view = useRouterView(props.client);
  return (
    <Show
      when={view()}
      fallback={
        <Stack gap="3" aria-label={t('wisp.router.pane.loading')}>
          <Skeleton width="1/2" />
          <Skeleton width="full" />
          <Skeleton width="full" />
        </Stack>
      }
    >
      {(v) => <Body client={props.client} view={v()} />}
    </Show>
  );
}

