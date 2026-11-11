// Settings → Usage (v1 settings.js usage, design/v1-reference/settings.usage): spend and outcomes over the
// last 7 days, each plan's usage windows as Claude Code and Codex report them, and where unattended work
// stops (Automations stop at, and each harness's own line).
import { createResource, For, onCleanup, Show, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { ChoiceSetting, Meter, SelectSetting, SettingsGroup, SettingsRow, Stats, useSignal, type SettingSource } from '@wisp/ui';
import { META, plans, setStop, TOPIC, usage, type AccountPlan } from '../commands.ts';
import { t } from '../i18n.ts';
import { fromRow } from '../source.ts';

/** v1 Subagents run on: the model Claude Code's own subagents use ('' = the task's), read by the runtime as
 * `runtime.subagentModel` and passed to claude as CLAUDE_CODE_SUBAGENT_MODEL. */
const SUBAGENT_KEY = 'runtime.subagentModel';
function subagentSource(c: PluginClient): SettingSource<string> {
  const s = fromRow(c, SUBAGENT_KEY, '');
  return {
    value: () => {
      const v = (s.value as () => unknown)();
      return v === 'haiku' || v === 'sonnet' ? v : 'task';
    },
    ...(s.lockedBy && { lockedBy: s.lockedBy }),
    set: (v) => s.set(v === 'task' ? '' : v),
  };
}

const STOPS = ['off', '50', '75', '90'] as const;
type Stop = 'same' | (typeof STOPS)[number];
const PLANNED = [
  { agent: 'claude', name: 'Claude Code', key: 'autoStopClaude' },
  { agent: 'codex', name: 'Codex', key: 'autoStopCodex' },
] as const;

const money = (n: number): string => `$${n.toFixed(2)}`;

export default function Usage(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('usage-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const meta = useSignal(c.entities.row<{ body: Record<string, string> }>(META, entityKey(peer, 'settings')));
  const [line] = createResource(() => c.run(usage, { peer }).catch(() => undefined));
  const [windows] = createResource(async () => {
    const out: { agent: string; name: string; accounts: AccountPlan[] }[] = [];
    for (const p of PLANNED) out.push({ agent: p.agent, name: p.name, accounts: await c.run(plans, { peer, agent: p.agent }).catch(() => []) });
    return out;
  });
  const stop = (key: string, dflt: string) => ({
    value: () => meta()?.body?.[key] ?? dflt,
    set: (v: string) => void c.run(setStop, { peer, key, value: v }).catch(() => {}),
  });
  const reported = (): boolean => (windows() ?? []).some((w) => w.accounts.some((a) => a.windows.length > 0));
  const worked = (): string => {
    const w = line()?.worked;
    return w === null || w === undefined ? '—' : `${w}%`;
  };
  const label = (name: string, account: string, window: string): string => [name, account && account !== 'default' ? account : '', window].filter(Boolean).join(' · ');
  return (
    <>
      <Stats
        compact
        part="budget.usage.stats"
        items={[
          { label: t('budget.usage.spend'), value: line() ? money(line()?.spend ?? 0) : '—' },
          { label: t('budget.usage.turns'), value: line()?.turns ?? '—' },
          { label: t('budget.usage.worked'), value: worked() },
          { label: t('budget.usage.questions'), value: line()?.questions ?? '—' },
        ]}
      />
      <SettingsGroup part="budget.usage.plan" title={t('budget.usage.plan.title')} description={t('budget.usage.plan.description')}>
        <Show when={reported()} fallback={<SettingsRow part="budget.usage.plan.none" title="" description={t('budget.usage.plan.none')} control={<span />} />}>
          <For each={windows() ?? []}>
            {(h) => (
              <For each={h.accounts}>
                {(a) => <For each={a.windows}>{(w) => <Meter part="budget.usage.window" label={label(h.name, a.account, w.label)} value={w.used} valueText={`${Math.round(w.used)}%`} tone={w.used >= 90 ? 'bad' : w.used >= 75 ? 'warn' : 'neutral'} />}</For>}
              </For>
            )}
          </For>
        </Show>
        <SelectSetting
          part="settings.subagentModel"
          title={t('budget.usage.subagents.title')}
          description={t('budget.usage.subagents.description')}
          source={subagentSource(c)}
          items={(['task', 'haiku', 'sonnet'] as const).map((v) => ({ value: v, label: t(`budget.usage.subagents.${v}`) }))}
        />
        <ChoiceSetting part="budget.usage.stop" title={t('budget.usage.stop.title')} description={t('budget.usage.stop.description')} source={stop('autoStop', 'off')} items={STOPS.map((v) => ({ value: v, label: t(`budget.usage.stop.${v}`) }))} />
        <For each={PLANNED}>
          {(p) => <ChoiceSetting part="budget.usage.stop.own" title={p.name} description={t('budget.usage.stop.own')} source={stop(p.key, 'same')} items={(['same', ...STOPS] as Stop[]).map((v) => ({ value: v, label: t(`budget.usage.stop.${v}`) }))} />}
        </For>
      </SettingsGroup>
    </>
  );
}
