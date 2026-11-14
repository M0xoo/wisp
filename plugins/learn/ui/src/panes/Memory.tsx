// Settings → Memory (v1 settings.js learn and the memory modal): Learn from tasks (`learn.enabled`), what's
// remembered with Open memory: each scope's preferences and lessons (every project, then each project) with remove
// and add (`learn.set`), and the recent retros, what each added or removed. A change shows at once and goes back
// with the shell's toast when refused.
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { Button, englishT, IconButton, Inline, Input, SettingsGroup, SettingsRow, Stack, SwitchSetting, Text, timeLabel, type SettingSource } from '@wisp/ui';
import { t } from '../i18n.ts';
import { rememberedLine, scopes, withItem, without, type Kind, type Lists, type View } from '../model.ts';
import { fromRow } from '../source.ts';

const read = defineCommand<{ peer: PeerId }, View>({ id: 'learn.view', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'Memory' });
const set = defineCommand<{ peer: PeerId; scope: string; kind: Kind; items: readonly string[] }, Lists>({
  id: 'learn.set',
  owner: (a) => a.peer,
  wire: (a) => ({ scope: a.scope, kind: a.kind, items: a.items }),
  optimistic: 'none',
  pending: 'the list',
});

export default function Memory(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const [view, { mutate, refetch }] = createResource(() => c.run(read, { peer }).catch(() => undefined));
  const [open, setOpen] = createSignal(false);
  const [adding, setAdding] = createSignal<Record<string, string>>({});
  const ago = (at: number): string => timeLabel(at, Date.now(), englishT);
  const on = fromRow(c, 'learn.enabled', true);
  const enabled: SettingSource<boolean> = {
    value: () => {
      const v = (on.value as () => unknown)();
      return !(v === false || v === 'off');
    },
    ...(on.lockedBy && { lockedBy: on.lockedBy }),
    set: (x) => on.set(x),
  };
  // the list changes at once; a refusal reads it back
  const edit = (scope: string, kind: Kind, items: readonly string[]): void => {
    const v = view();
    if (v) {
      const patch = (l: Lists): Lists => ({ ...l, [kind]: items });
      mutate(scope === 'global' ? { ...v, global: patch(v.global) } : { ...v, projects: { ...v.projects, [scope]: patch(v.projects[scope] ?? { preferences: [], lessons: [] }) } });
    }
    c.run(set, { peer, scope, kind, items }).catch(() => void refetch());
  };
  const list = (scope: string, kind: Kind, items: readonly string[]): JSX.Element => {
    const k = `${scope}:${kind}`;
    return (
      <SettingsGroup part={`learn.${kind}`} title={t(`learn.${kind}`)}>
        <For each={items}>
          {(text, i) => (
            <SettingsRow part="learn.item" title="" description={text} control={<IconButton icon="x" size="xs" label={t('learn.remove')} onClick={() => edit(scope, kind, without(items, i()))} />} />
          )}
        </For>
        <SettingsRow
          part="learn.add"
          title=""
          wideControl
          description={items.length === 0 ? t(`learn.${kind}.none`) : undefined}
          control={
            <Input
              size="sm"
              value={adding()[k] ?? ''}
              placeholder={t(`learn.${kind}.add`)}
              aria-label={t(`learn.${kind}.add`)}
              onInput={(v) => setAdding({ ...adding(), [k]: v })}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                edit(scope, kind, withItem(items, adding()[k] ?? ''));
                setAdding({ ...adding(), [k]: '' });
              }}
            />
          }
        />
      </SettingsGroup>
    );
  };
  return (
    <Show
      when={open()}
      fallback={
        <SettingsGroup part="learn.home">
          <SwitchSetting part="settings.learn" title={t('learn.on.title')} description={t('learn.on.description')} source={enabled} />
          <SettingsRow
            part="learn.remembered"
            title={t('learn.remembered')}
            description={view() ? rememberedLine(view() as View, ago, t as never) : view.loading ? t('learn.loading') : t('learn.nothing')}
            control={
              <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                {t('learn.open')}
              </Button>
            }
          />
        </SettingsGroup>
      }
    >
      <Stack gap="4" part="learn.memory">
        <Inline>
          <Button size="sm" variant="ghost" icon="back" onClick={() => setOpen(false)}>
            {t('learn.back')}
          </Button>
        </Inline>
        <For each={view() ? scopes(view() as View) : []}>
          {(s) => (
            <Stack gap="3" part="learn.scope">
              <Text weight="semibold">{s.scope === 'global' ? t('learn.global') : t('learn.project', { name: s.name })}</Text>
              {list(s.scope, 'preferences', s.lists.preferences)}
              {list(s.scope, 'lessons', s.lists.lessons)}
            </Stack>
          )}
        </For>
        <SettingsGroup part="learn.history" title={t('learn.history')}>
          <Show when={(view()?.history.length ?? 0) > 0} fallback={<SettingsRow part="learn.history.none" title="" description={t('learn.history.none')} control={<span />} />}>
            <For each={[...(view()?.history ?? [])].reverse()}>
              {(r) => (
                <SettingsRow
                  part="learn.retro"
                  title={r.title || r.project}
                  description={`${ago(r.at)} · ${r.status === 'learned' ? t('learn.retro.learned', { added: r.added.length, removed: r.removed.length }) : r.status === 'failed' ? (r.error ?? t('learn.retro.failed')) : t('learn.retro.nothing')}`}
                  control={<span />}
                />
              )}
            </For>
          </Show>
        </SettingsGroup>
      </Stack>
    </Show>
  );
}
