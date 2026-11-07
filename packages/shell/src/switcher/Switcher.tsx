// The ⌃Tab switcher's view and keys (desktop app only: Chrome keeps ⌃Tab for its own tabs). Keys
// are read on the window in the capture phase, before a terminal or a text box keeps them.

import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import { untracked, type EntityKey, type Readable } from '@wisp/client';
import { Dialog, Kbd, ListRow, Stack, Text } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type SessionRow } from '../rows.ts';
import { SHOW_AFTER_MS, pick, startSwitch, step, type SwitchState } from './model.ts';

export default function Switcher(props: { readonly recent: Readable<readonly string[]> }): JSX.Element {
  const shell = useShell();
  const [st, setSt] = createSignal<SwitchState | undefined>(undefined);
  const [shown, setShown] = createSignal(false);
  const scope = shell.client.scope.child('switcher');
  onCleanup(() => scope.dispose());
  let cancelShow: (() => void) | undefined;
  const row = (id: string): SessionRow | undefined => shell.client.entities.peek<SessionRow>(SESSION, id as EntityKey) as SessionRow | undefined;
  const fits = (id: string): boolean => {
    const s = row(id);
    return s !== undefined && !s.archived;
  };
  const finish = (open: boolean): void => {
    const s = st();
    cancelShow?.();
    setSt(undefined);
    setShown(false);
    const id = s && open ? pick(s) : undefined;
    if (id) shell.navigate({ t: 'openTask', id: id as never });
  };
  const down = (e: KeyboardEvent): void => {
    if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const cur = st();
      if (cur) return void (setSt(step(cur, e.shiftKey ? -1 : 1)), setShown(true));
      const n = shell.nav().main;
      const next = startSwitch(n.kind === 'task' ? n.id : undefined, untracked(props.recent), fits, e.shiftKey);
      if (!next) return;
      setSt(next);
      cancelShow = scope.timeout(SHOW_AFTER_MS, () => setShown(true));
    } else if (st() && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  const up = (e: KeyboardEvent): void => {
    if (st() && e.key === 'Control') finish(true);
  };
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  onCleanup(() => {
    window.removeEventListener('keydown', down, true);
    window.removeEventListener('keyup', up, true);
  });
  return (
    <Show when={shown() && st()}>
      {(s) => (
        <Dialog open size="sm" title={shell.t('shell.switcher.title')} onOpenChange={(o) => (o ? undefined : finish(false))} part="shell.switcher">
          <Stack gap="1" role="listbox" aria-label={shell.t('shell.switcher.title')}>
            <For each={s().ids}>
              {(id, i) => <ListRow title={row(id)?.title ?? id} selected={i() === s().sel} part="shell.switcher.row" onOpen={() => (setSt({ ...s(), sel: i() }), finish(true))} />}
            </For>
          </Stack>
          <Text size="xs" tone="faint">
            <Kbd keys={['Tab']} /> {shell.t('shell.switcher.next')} · <Kbd keys={['⇧', 'Tab']} /> {shell.t('shell.switcher.back')} · <Kbd keys={['esc']} /> {shell.t('shell.switcher.stay')}
          </Text>
        </Dialog>
      )}
    </Show>
  );
}
