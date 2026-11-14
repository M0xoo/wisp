// What Settings → Cloud and Settings → Machines (v1 mountGridHere) read of this computer's grid sign-in: the row,
// the address being typed, the sign-in under way, and Sign in.
import { createSignal, onCleanup } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import { DEFAULT_GRID, KIND, signIn, TOPIC, type CloudRow } from '../commands.ts';
import { t } from '../i18n.ts';

export const host = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

export function useCloud(c: PluginClient) {
  const peer = c.home;
  const scope = c.scope.child('cloud-state');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const row = useSignal(c.entities.row<CloudRow>(KIND, entityKey(peer, 'this')));
  const r = (): CloudRow | undefined => row() as CloudRow | undefined;
  const [grid, setGrid] = createSignal(DEFAULT_GRID);
  const [starting, setStarting] = createSignal(false);
  const waiting = () => (r()?.signin?.state === 'waiting' ? r()?.signin : undefined);
  const failed = () => (r()?.signin && ['denied', 'expired', 'failed'].includes(r()?.signin?.state ?? '') ? r()?.signin?.error : undefined);
  const start = (): void => {
    setStarting(true);
    c.run(signIn, { peer, grid: grid() })
      .then((s) => {
        if (s.verifyUrl) window.open(s.verifyUrl, '_blank', 'noopener');
      })
      .catch(() => {})
      .finally(() => setStarting(false));
  };
  const computerLine = (): string => {
    const k = r()?.computer;
    if (!k?.on) return t('grid-client.computer.off');
    if (k.state === 'online') return k.url ? t('grid-client.computer.online', { url: host(k.url) }) : t('grid-client.computer.onlineNoUrl');
    if (k.state === 'retrying') return k.error || t('grid-client.computer.retrying');
    return t('grid-client.computer.connecting');
  };
  return { c, peer, r, grid, setGrid, starting, waiting, failed, start, computerLine };
}
