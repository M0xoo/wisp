// My shares (ADR-0038, F-share-3): everything you've shared through wisp Cloud, under Settings → Cloud. Each with
// what it is, who may open it, its views, imports and version; Copy link, Open and Stop sharing. Stopping shows at
// once (the row says Stopped) and comes back with the shell's toast if the grid refuses.
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { IconButton, Inline, SettingsGroup, SettingsRow } from '@wisp/ui';
import { t } from '../i18n.ts';
import { ordered, shareLine, sharesOf, type Share } from '../shares.ts';

const list = defineCommand<{ peer: PeerId }, unknown>({ id: 'grid-client.shares', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'your shares' });
const revoke = defineCommand<{ peer: PeerId; id: string }>({ id: 'grid-client.revoke', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: 'none', pending: 'Stop sharing' });

export function MyShares(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [got] = createResource(() => c.run(list, { peer: c.home }).then(sharesOf, () => [] as Share[]));
  // stopped here, before the grid answers (the row says so at once)
  const [stopped, setStopped] = createSignal<ReadonlySet<string>>(new Set());
  const now = (): number => c.scope.timers.now();
  const shown = (): Share[] =>
    ordered(
      (got() ?? []).map((s) => (stopped().has(s.id) ? { ...s, revoked: true } : s)),
      now(),
    );
  const stop = (s: Share): void => {
    setStopped(new Set([...stopped(), s.id]));
    c.run(revoke, { peer: c.home, id: s.id }).then(
      () => shell.toast.show(say('grid-client.shares.stopped', { title: s.title })),
      () => setStopped(new Set([...stopped()].filter((x) => x !== s.id))),
    );
  };
  const copy = (s: Share): void => void shell.platform.copy(s.url).then((ok) => ok && shell.toast.show(t('grid-client.shares.copied')));
  return (
    <SettingsGroup part="grid-client.shares" title={t('grid-client.shares.title')} description={t('grid-client.shares.description')}>
      <Show when={!got.loading} fallback={<SettingsRow part="grid-client.shares.loading" title="" description={t('grid-client.shares.loading')} control={<span />} />}>
        <Show when={shown().length > 0} fallback={<SettingsRow part="grid-client.shares.none" title="" description={t('grid-client.shares.none')} control={<span />} />}>
          <For each={shown()}>
            {(s) => (
              <SettingsRow
                part="grid-client.share"
                title={s.title}
                description={shareLine(s, now(), say)}
                control={
                  <Show when={!s.revoked && !(s.expiresAt && s.expiresAt <= now())}>
                    <Inline gap="1">
                      <IconButton icon="copy" size="sm" variant="ghost" label={t('grid-client.shares.copy')} onClick={() => copy(s)} />
                      <IconButton icon="external" size="sm" variant="ghost" label={t('grid-client.shares.open')} onClick={() => shell.platform.openExternal(s.url)} />
                      <IconButton icon="x" size="sm" variant="ghost" label={t('grid-client.shares.stop')} onClick={() => stop(s)} />
                    </Inline>
                  </Show>
                }
              />
            )}
          </For>
        </Show>
      </Show>
    </SettingsGroup>
  );
}
