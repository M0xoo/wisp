// Settings → Automations (v1 settings.js automations, design/v1-reference/settings.automations): saved prompts
// (recipes) and the triggers that launch them. Each recipe runs now or goes; each trigger says its state,
// how often it ran and when last, and runs now. Lists are read when the pane opens and after a change.
import { createResource, For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { englishT, Menu, Pill, SettingsGroup, SettingsRow, Text, timeLabel } from '@wisp/ui';
import { fireTrigger, recipes, removeRecipe, runRecipe, triggers, type Recipe, type Trigger } from '../commands.ts';
import { t } from '../i18n.ts';

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { on: 'good', off: 'neutral', held: 'warn', failing: 'bad' };

export default function Automations(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const [rs, { refetch: again }] = createResource(() => c.run(recipes, { peer }).catch((): Recipe[] => []));
  const [ts, { refetch: againT }] = createResource(() => c.run(triggers, { peer }).catch((): Trigger[] => []));
  const after = (p: Promise<unknown>, then: () => void): void => {
    p.then(then, () => {}); // a refusal toasts from the shell
  };
  const ago = (at: number | null | undefined): string => (at ? timeLabel(at, Date.now(), englishT) : t('automations.never'));
  return (
    <>
      <Text as="p" tone="muted" part="automations.lede">
        {t('automations.lede')}
      </Text>
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
                    items={[
                      { value: 'run', label: t('automations.run'), icon: 'play' },
                      { kind: 'separator' },
                      { value: 'remove', label: t('automations.remove'), icon: 'trash', danger: true },
                    ]}
                    onSelect={(v) => after(v === 'run' ? c.run(runRecipe, { peer, name: r.name }) : c.run(removeRecipe, { peer, name: r.name }), () => void again())}
                  />
                }
              />
            )}
          </For>
        </Show>
      </SettingsGroup>
      <SettingsGroup part="automations.triggers" title={t('automations.triggers')} description={t('automations.triggers.description')}>
        <Show when={(ts() ?? []).length > 0} fallback={<SettingsRow part="automations.triggers.empty" title={t('automations.none')} description={t('automations.triggers.none')} control={<span />} />}>
          <For each={ts() ?? []}>
            {(x) => (
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
                      items={[{ value: 'fire', label: t('automations.fire'), icon: 'play' }]}
                      onSelect={() => after(c.run(fireTrigger, { peer, name: x.name }), () => void againT())}
                    />
                  </>
                }
              />
            )}
          </For>
        </Show>
      </SettingsGroup>
    </>
  );
}
