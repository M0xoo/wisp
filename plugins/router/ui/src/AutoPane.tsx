// Settings → Auto (v1 settings.js data-pane="auto"): the goal, learning from your picks, trying new
// models, which harnesses it may use, hand-over, best of two, scout first, and What it learned.
// Every row shows its change at once; a refusal puts it back (the command's optimistic patch).

import { For, onCleanup, type JSX } from 'solid-js';
import { computed, type PluginClient, type Readable } from '@wisp/client';
import { useShell, type HarnessUiDef } from '@wisp/shell';
import { Button, ChoiceSetting, SettingsGroup, SettingsRow, SwitchSetting, Text, Wrap, useSignal, type SettingSource } from '@wisp/ui';
import { routerSet, viewKey } from './commands.ts';
import { t } from './i18n.ts';
import { harnessOf } from './rules.ts';
import { GOALS, KIND, SCOUTS, TOPIC, type RouterPatch, type RouterSettings, type RouterView } from './types.ts';
import { LEARNED } from './views.ts';

type Bool = 'habits' | 'explore' | 'escalate' | 'best2';

function sources(client: PluginClient): { row: Readable<RouterView | undefined>; set: (p: RouterPatch) => void } {
  const row = client.entities.row<RouterView>(KIND.view, viewKey(client.home)) as Readable<RouterView | undefined>;
  const set = (patch: RouterPatch): void => void client.run(routerSet, { peer: client.home, patch }).catch(() => {});
  return { row, set };
}

/** One setting as a kit row reads it: an alien-signals getter over the view row, and its write. */
function bound<V>(row: Readable<RouterView | undefined>, get: (v: RouterView | undefined) => V, set: (v: V) => void): SettingSource<V> {
  return { value: computed(() => get(row())), set };
}

function Allowed(props: { readonly view: RouterView | undefined; readonly set: (p: RouterPatch) => void }): JSX.Element {
  const marks = useSignal(useShell().harnesses());
  // v1 .ro-allowed: each harness that can run (here or on a machine), and any already on, as a chip with its logo
  const agents = (): { id: string; name: string; logo: string | undefined }[] => {
    const seen = new Map<string, string>();
    for (const a of props.view?.arms ?? []) if (a.state !== 'gone' && !seen.has(a.agent)) seen.set(a.agent, harnessOf(a.label));
    for (const id of allowed()) if (!seen.has(id)) seen.set(id, id);
    const mark = (id: string): HarnessUiDef | undefined => marks().find((m) => m.id === id);
    return [...seen].map(([id, name]) => ({ id, name: mark(id)?.name ?? name, logo: mark(id)?.logo }));
  };
  const allowed = (): readonly string[] => props.view?.settings.allowed ?? [];
  const flip = (id: string): void => {
    const on = !allowed().includes(id);
    const next = on ? [...allowed(), id] : allowed().filter((x) => x !== id);
    props.set({ allowed: next.length ? next : null });
  };
  return (
    <Wrap gap="2" part="router.allowed">
      <For each={agents()}>
        {(a) => (
          <Button variant="chip" logo={a.logo} title={a.name} pressed={allowed().includes(a.id)} onClick={() => flip(a.id)}>
            {a.name}
          </Button>
        )}
      </For>
    </Wrap>
  );
}

/** v1 .ro-hint: "4 picks of yours · 1 correction · 3 runs learned from", or where it starts when there's none */
function learnedHint(v: RouterView | undefined): string {
  const bits = [
    v?.picks ? t('wisp.router.pane.learned-picks', { count: v.picks }) : '',
    v?.corrections ? t('wisp.router.pane.learned-corrections', { count: v.corrections }) : '',
    v?.learned ? t('wisp.router.pane.learned-runs', { count: v.learned }) : '',
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : t('wisp.router.pane.learned-empty');
}

export default function AutoPane(props: { readonly client: PluginClient }): JSX.Element {
  const scope = props.client.scope.child('router.pane');
  onCleanup(() => scope.dispose());
  props.client.watch(props.client.home, TOPIC.view, scope);
  const { row, set } = sources(props.client);
  const view = useSignal(row);
  const flag = (k: Bool): SettingSource<boolean> => bound(row, (v) => v?.settings[k] === true, (on) => set({ [k]: on }));
  const goal = bound<string>(row, (v) => v?.goal ?? 'balanced', (g) => set({ goal: g }));
  const scout = bound<string>(row, (v) => (v?.settings as RouterSettings | undefined)?.scout ?? 'off', (s) => set({ scout: s }));
  const open = (): void => props.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: LEARNED as never, params: { peer: props.client.home } } });
  return (
    <>
      <SettingsGroup part="router.pane">
        <ChoiceSetting title={t('wisp.router.pane.goal')} description={t('wisp.router.pane.goal-hint')} items={GOALS.map((g) => ({ value: g, label: t(`wisp.router.goal.${g}`) }))} source={goal} />
        <SwitchSetting title={t('wisp.router.pane.habits')} description={t('wisp.router.pane.habits-hint')} source={flag('habits')} />
        <SwitchSetting title={t('wisp.router.pane.explore')} description={t('wisp.router.pane.explore-hint')} source={flag('explore')} />
        <SettingsRow title={t('wisp.router.pane.allowed')} description={t('wisp.router.pane.allowed-hint')} choices control={<Allowed view={view()} set={set} />} />
      </SettingsGroup>
      <SettingsGroup>
        <SwitchSetting title={t('wisp.router.pane.escalate')} description={t('wisp.router.pane.escalate-hint')} source={flag('escalate')} />
        <SwitchSetting title={t('wisp.router.pane.best2')} description={t('wisp.router.pane.best2-hint')} source={flag('best2')} />
        <ChoiceSetting title={t('wisp.router.pane.scout')} description={t('wisp.router.pane.scout-hint')} items={SCOUTS.map((s) => ({ value: s, label: t(`wisp.router.scout.${s}`) }))} source={scout} />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title={t('wisp.router.pane.learned')}
          description={<Text size="sm" tone="muted">{learnedHint(view())}</Text>}
          control={
            <Button size="sm" variant="ghost" onClick={open}>
              {t('wisp.router.pane.open')}
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}
