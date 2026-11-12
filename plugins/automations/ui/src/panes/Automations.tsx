// Settings → Automations (v1 settings.js automations, design/v1-reference/settings.automations): one group, as
// v1 had it: Recipes and Triggers, each a line saying what there is with Manage (its list: run now, remove; a
// trigger's state, how often it ran and when last), and Webhook triggers (other services may start this
// computer's webhook triggers; off, those URLs refuse every call). Lists are read when the pane opens and after a change.
import { createResource, createSignal, For, Match, Show, Switch, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Button, englishT, Inline, Menu, Pill, SettingsGroup, SettingsRow, SwitchSetting, timeLabel, type SettingSource } from '@wisp/ui';
import { fireTrigger, recipes, removeRecipe, runRecipe, testTrigger, triggers, type Recipe, type Tried, type Trigger } from '../commands.ts';
import { TriggerEditor } from './TriggerEditor.tsx';
import { t } from '../i18n.ts';
import { fromRow } from '../source.ts';

/** `automations.webhookTriggers`, a bool setting (off by default): a boolean source, 'off' read as off. */
function webhooks(c: PluginClient): SettingSource<boolean> {
  const s = fromRow(c, 'automations.webhookTriggers', false);
  return {
    value: () => {
      const v = (s.value as () => unknown)();
      return v === true || v === 'on';
    },
    ...(s.lockedBy && { lockedBy: s.lockedBy }),
    set: (on) => s.set(on),
  };
}

/** "None yet · save a prompt you run often", or the names (the first three, then how many more). */
export function summary(names: readonly string[], none: string): string {
  if (names.length === 0) return `${t('automations.none')} · ${none}`;
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? t('automations.summary.more', { names: shown, n: names.length - 3 }) : shown;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { on: 'good', off: 'neutral', held: 'warn', failing: 'bad' };

/** `filter` (Settings' param): the tab it opens on, as v1's ⌘K Recipes and Triggers opened Automations on theirs */
export default function Automations(props: { readonly client: PluginClient; readonly filter?: string }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const [rs, { refetch: again }] = createResource(() => c.run(recipes, { peer }).catch((): Recipe[] => []));
  const [ts, { refetch: againT }] = createResource(() => c.run(triggers, { peer }).catch((): Trigger[] => []));
  const after = (p: Promise<unknown>, then: () => void): void => {
    p.then(then, () => {}); // a refusal toasts from the shell
  };
  const ago = (at: number | null | undefined): string => (at ? timeLabel(at, Date.now(), englishT) : t('automations.never'));
  const [view, setView] = createSignal<'home' | 'recipes' | 'triggers'>(props.filter === 'recipes' || props.filter === 'triggers' ? props.filter : 'home');
  const [adding, setAdding] = createSignal(false);
  const [tried, setTried] = createSignal<Record<string, Tried[]>>({});
  const back = (): JSX.Element => (
    <Button size="sm" variant="ghost" icon="back" part="automations.back" onClick={() => setView('home')}>
      {t('automations.back')}
    </Button>
  );
  return (
    <Switch>
      <Match when={view() === 'home'}>
        <SettingsGroup part="automations.home">
          <SettingsRow
            part="automations.recipes.line"
            title={t('automations.recipes')}
            description={summary(
              (rs() ?? []).map((r) => r.name),
              t('automations.recipes.none').toLowerCase(),
            )}
            control={
              <Button size="sm" variant="ghost" onClick={() => setView('recipes')}>
                {t('automations.manage')}
              </Button>
            }
          />
          <SettingsRow
            part="automations.triggers.line"
            title={t('automations.triggers')}
            description={summary(
              (ts() ?? []).map((x) => x.name),
              t('automations.triggers.short'),
            )}
            control={
              <Button size="sm" variant="ghost" onClick={() => setView('triggers')}>
                {t('automations.manage')}
              </Button>
            }
          />
          <SwitchSetting
            part="settings.webhookTriggers"
            title={t('automations.webhooks')}
            description={t('automations.webhooks.description')}
            source={webhooks(c)}
            locked={(by) => t('automations.locked', { by })}
          />
        </SettingsGroup>
      </Match>
      <Match when={view() === 'recipes'}>
        {back()}
        <SettingsGroup part="automations.recipes" title={t('automations.recipes')} description={t('automations.recipes.description')}>
          <Show when={(rs() ?? []).length > 0} fallback={<SettingsRow part="automations.recipes.empty" title={t('automations.none')} description={t('automations.recipes.none')} control={<span />} />}>
            <For each={rs() ?? []}>
              {(r) => (
                <SettingsRow
                  part="automations.recipe"
                  title={r.name}
                  description={clip(r.prompt.replace(/\s+/g, ' '), 120)}
                  control={
                    <Menu
                      trigger={{ icon: 'dots', 'aria-label': t('automations.more', { name: r.name }), variant: 'ghost', size: 'sm' }}
                      items={[{ value: 'run', label: t('automations.run'), icon: 'play' }, { kind: 'separator' }, { value: 'remove', label: t('automations.remove'), icon: 'trash', danger: true }]}
                      onSelect={(v) => after(v === 'run' ? c.run(runRecipe, { peer, name: r.name }) : c.run(removeRecipe, { peer, name: r.name }), () => void again())}
                    />
                  }
                />
              )}
            </For>
          </Show>
        </SettingsGroup>
      </Match>
      <Match when={view() === 'triggers'}>
        <Inline gap="2" justify="between">
          {back()}
          <Show when={!adding()}>
            <Button size="sm" variant="ghost" icon="plus" part="automations.trigger.new" onClick={() => setAdding(true)}>
              {t('automations.editor.new')}
            </Button>
          </Show>
        </Inline>
        <Show when={adding()}>
          <TriggerEditor
            client={c}
            onDone={(saved) => {
              setAdding(false);
              if (saved) void againT();
            }}
          />
        </Show>
        <SettingsGroup part="automations.triggers" title={t('automations.triggers')} description={t('automations.triggers.description')}>
          <Show
            when={(ts() ?? []).length > 0}
            fallback={<SettingsRow part="automations.triggers.empty" title={t('automations.none')} description={t('automations.triggers.none')} control={<span />} />}
          >
            <For each={ts() ?? []}>
              {(x) => (
                <>
                  <SettingsRow
                    part="automations.trigger"
                    title={x.name}
                    description={x.why || t('automations.trigger.line', { runs: x.runs, last: ago(x.lastRunAt) })}
                    control={
                      <>
                        <Pill tone={TONE[x.state] ?? 'neutral'} dot variant="outline">
                          {x.state}
                        </Pill>
                        <Menu
                          trigger={{ icon: 'dots', 'aria-label': t('automations.more', { name: x.name }), variant: 'ghost', size: 'sm' }}
                          items={[
                            { value: 'test', label: t('automations.test'), icon: 'search' },
                            { value: 'fire', label: t('automations.fire'), icon: 'play' },
                          ]}
                          onSelect={(v) =>
                            v === 'test'
                              ? void c.run(testTrigger, { peer, name: x.name }).then(
                                  (r) => setTried({ ...tried(), [x.name]: r }),
                                  () => {},
                                )
                              : after(c.run(fireTrigger, { peer, name: x.name }), () => void againT())
                          }
                        />
                      </>
                    }
                  />
                  {/* would it have fired: the last five events of its source, dry run (ADR-0043's live preview) */}
                  <Show when={tried()[x.name]}>
                    {(list) => (
                      <Show when={list().length > 0} fallback={<SettingsRow part="automations.tried.none" title="" description={t('automations.tried.none')} control={<span />} />}>
                        <For each={list()}>
                          {(r) => <SettingsRow part="automations.tried" title={r.summary || r.key} description={[r.result, r.why].filter(Boolean).join(' · ')} control={<span />} />}
                        </For>
                      </Show>
                    )}
                  </Show>
                </>
              )}
            </For>
          </Show>
        </SettingsGroup>
      </Match>
    </Switch>
  );
}
