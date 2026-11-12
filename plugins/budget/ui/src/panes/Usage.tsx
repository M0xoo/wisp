// Settings → Usage (v1 settings.js usage, design/v1-reference/settings.usage): spend and outcomes over the
// last 7 days, each plan's usage windows as Claude Code and Codex report them, and where unattended work
// stops (Automations stop at, and each harness's own line).
import { createResource, For, onCleanup, Show, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { Slot, useShell } from '@wisp/shell';
import {
  Callout,
  ChoiceSetting,
  IconButton,
  Inline,
  Meter,
  SelectSetting,
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  Stack,
  Stats,
  SwitchSetting,
  Text,
  Button,
  timeLabel,
  englishT,
  useSignal,
  type SettingSource,
} from '@wisp/ui';
import { dismissDrain, dismissNotice, META, plans, setStop, TOPIC, usage, type AccountPlan } from '../commands.ts';
import { drainLines, drainReport, noticeWords, pct } from '../drain.ts';
import { VIEW_USAGE } from '../views.ts';
import { t } from '../i18n.ts';
import { fromRow } from '../source.ts';

/** v1 Subagents run on: the model Claude Code's own subagents use ('task' = the task's), read by the runtime as
 * `runtime.subagentModel` and passed to claude as CLAUDE_CODE_SUBAGENT_MODEL. */
const SUBAGENT_KEY = 'runtime.subagentModel';
function subagentSource(c: PluginClient): SettingSource<string> {
  const s = fromRow(c, SUBAGENT_KEY, 'task');
  return {
    value: () => {
      const v = (s.value as () => unknown)();
      return v === 'haiku' || v === 'sonnet' ? v : 'task';
    },
    ...(s.lockedBy && { lockedBy: s.lockedBy }),
    // an enum value is never '' (the kernel refuses the manifest): 'task' is the task's own model
    set: (v) => s.set(v),
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
  const [windows, { refetch: again }] = createResource(async () => {
    const out: { agent: string; name: string; accounts: AccountPlan[] }[] = [];
    for (const p of PLANNED) out.push({ agent: p.agent, name: p.name, accounts: await c.run(plans, { peer, agent: p.agent }).catch(() => []) });
    return out;
  });
  const stop = (key: string, dflt: string) => ({
    value: () => meta()?.body?.[key] ?? dflt,
    set: (v: string) => void c.run(setStop, { peer, key, value: v }).catch(() => {}),
  });
  // Drain watch (`budget.drainWatch`, a bool setting): the switch, and each account's card while it's on
  const drainSrc = fromRow(c, 'budget.drainWatch', false);
  const watching = (): boolean => {
    const v = (drainSrc.value as () => unknown)();
    return v === true || v === 'on';
  };
  const drainWatch: SettingSource<boolean> = { value: watching, ...(drainSrc.lockedBy && { lockedBy: drainSrc.lockedBy }), set: (on) => drainSrc.set(on) };
  // a bool setting as a switch (true / false; v1's 'on' read as true)
  const onOff = (key: string, dflt: boolean): SettingSource<boolean> => {
    const src = fromRow(c, key, dflt);
    const v = (): boolean => {
      const x = (src.value as () => unknown)();
      return x === true || x === 'on' || (x !== false && x !== 'off' && dflt);
    };
    return { value: v, ...(src.lockedBy && { lockedBy: src.lockedBy }), set: (on) => src.set(on) };
  };
  // Ask near the limit (`budget.limitHold`: off, 80, 90, 95)
  const holdSrc = fromRow(c, 'budget.limitHold', '90');
  const hold: SettingSource<string> = { value: () => String((holdSrc.value as () => unknown)() ?? '90'), ...(holdSrc.lockedBy && { lockedBy: holdSrc.lockedBy }), set: (v) => holdSrc.set(v) };
  const when = (at: number): string => timeLabel(at, Date.now(), englishT);
  const hide = (p: Promise<unknown>): void =>
    void p.then(
      () => void again(),
      () => {},
    );
  const reported = (): boolean => (windows() ?? []).some((w) => w.accounts.some((a) => a.windows.length > 0));
  const worked = (): string => {
    const w = line()?.worked;
    return w === null || w === undefined ? '—' : `${w}%`;
  };
  const label = (name: string, account: string, window: string): string => [name, account && account !== 'default' ? account : '', window].filter(Boolean).join(' · ');
  const marks = useSignal(useShell().harnesses());
  const logoOf = (id: string): string | undefined => marks().find((m) => m.id === id)?.logo;
  const meters = (): JSX.Element[] =>
    (windows() ?? []).flatMap((h) =>
      h.accounts.flatMap((a) =>
        a.windows.map((w) => (
          <Meter part="budget.usage.window" label={label(h.name, a.account, w.label)} value={w.used} valueText={pct(w.used)} tone={w.used >= 0.9 ? 'bad' : w.used >= 0.75 ? 'warn' : 'neutral'} />
        )),
      ),
    );
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
      {/* v1: Charts and breakdowns, then what other plugins add (wisp.crew's Crew track record) */}
      <SettingsGroup part="budget.usage.links">
        <SettingsRow
          part="budget.usage.charts"
          title={t('budget.usage.charts.title')}
          description={t('budget.usage.charts.description')}
          control={
            <Button size="sm" variant="ghost" part="budget.usage.open" onClick={() => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW_USAGE as never, params: null } })}>
              {t('budget.usage.open')}
            </Button>
          }
        />
        <Slot input="shell.settings:usage" layout="contents" />
      </SettingsGroup>
      <SettingsGroup part="budget.usage.plan" bodyPart="settings.budget" title={t('budget.usage.plan.title')} description={t('budget.usage.plan.description')}>
        <Show
          when={reported()}
          fallback={
            <SettingsNote boxed part="budget.usage.plan.none">
              {t('budget.usage.plan.none')}
            </SettingsNote>
          }
        >
          <Stack gap="4" part="budget.usage.windows">
            {meters()}
          </Stack>
        </Show>
        <For each={windows() ?? []}>
          {(h) => (
            <For each={h.accounts}>
              {(a) => (
                <>
                  <For each={a.notices ?? []}>
                    {(n) => (
                      <SettingsRow
                        part="budget.usage.notice"
                        title=""
                        description={noticeWords(n, label(h.name, a.account, ''), when)}
                        control={
                          <IconButton
                            icon="x"
                            size="xs"
                            label={t('budget.usage.notice.hide')}
                            onClick={() => hide(c.run(dismissNotice, { peer, agent: h.agent, account: a.account, window: n.window }))}
                          />
                        }
                      />
                    )}
                  </For>
                  <Show when={watching() && a.drain}>
                    {(d) => (
                      <Callout part="budget.usage.drain" tone="warn" icon="warn" title={drainLines(d(), when).title}>
                        <Text size="sm">{drainLines(d(), when).text}</Text>
                        <Inline gap="2">
                          <Button size="sm" variant="ghost" icon="copy" onClick={() => void navigator.clipboard?.writeText(drainReport(h.name, a.account, d(), when)).catch(() => {})}>
                            {t('budget.usage.drain.copy')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => hide(c.run(dismissDrain, { peer, agent: h.agent, account: a.account, window: d().id }))}>
                            {t('budget.usage.drain.dismiss')}
                          </Button>
                        </Inline>
                      </Callout>
                    )}
                  </Show>
                </>
              )}
            </For>
          )}
        </For>
        <SelectSetting
          part="settings.subagentModel"
          title={t('budget.usage.subagents.title')}
          description={t('budget.usage.subagents.description')}
          source={subagentSource(c)}
          items={(['task', 'haiku', 'sonnet'] as const).map((v) => ({ value: v, label: t(`budget.usage.subagents.${v}`) }))}
        />
        <ChoiceSetting
          part="settings.autoStop"
          title={t('budget.usage.stop.title')}
          description={t('budget.usage.stop.description')}
          source={stop('autoStop', 'off')}
          items={STOPS.map((v) => ({ value: v, label: t(`budget.usage.stop.${v}`) }))}
        />
        <For each={PLANNED}>
          {(p) => (
            <ChoiceSetting
              part="settings.autoStopBy"
              title={p.name}
              logo={logoOf(p.agent)}
              description={p.agent === 'codex' ? t('budget.usage.stop.codex') : t('budget.usage.stop.own')}
              source={stop(p.key, 'same')}
              items={(['same', ...STOPS] as Stop[]).map((v) => ({ value: v, label: t(`budget.usage.stop.${v}`) }))}
            />
          )}
        </For>
        <SwitchSetting part="settings.liveLimits" title={t('budget.usage.live.title')} description={t('budget.usage.live.description')} source={onOff('budget.liveLimits', false)} />
        <SwitchSetting part="settings.spareCard" title={t('budget.usage.spare.title')} description={t('budget.usage.spare.description')} source={onOff('budget.spareCard', true)} />
        <SwitchSetting part="settings.windowNotice" title={t('budget.usage.notices.title')} description={t('budget.usage.notices.description')} source={onOff('budget.windowNotice', true)} />
        <SwitchSetting part="settings.drainWatch" title={t('budget.usage.drain.title')} description={t('budget.usage.drain.description')} source={drainWatch} />
        <ChoiceSetting
          part="settings.limitHold"
          title={t('budget.usage.hold.title')}
          description={t('budget.usage.hold.description')}
          source={hold}
          items={(['off', '80', '90', '95'] as const).map((v) => ({ value: v, label: v === 'off' ? t('budget.usage.stop.off') : `${v}%` }))}
        />
        <SwitchSetting part="settings.limitWait" title={t('budget.usage.wait.title')} description={t('budget.usage.wait.description')} source={onOff('runtime.limitWait', false)} />
      </SettingsGroup>
      {/* v1 Machine load (wisp.machine), and anything else other plugins put at the end */}
      <Slot input="shell.settings:usageEnd" layout="contents" />
    </>
  );
}
