// The command palette (⌘K, v1 web/js/palette.js): one input over a grouped list of what every
// plugin offers (palette sources: this task's actions, tasks, projects, the app's commands). It is
// the `shell.palette` overlay view, so Back and Esc close it and Open on a toast closes it too.
// Arrows move, Enter runs, an item with `fill` types into the input instead. A source's `deep`
// answers come after a pause in typing and go under the rest, so nothing above them moves; an
// answer for words no longer in the box is dropped.

import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Icon, Input, Kbd, ListRow, Stack, Text, useSignal, type IconName } from '@wisp/ui';
import type { PaletteContext, PaletteItem } from '../contract.ts';
import { useShell } from '../context.tsx';
import { useClients } from '../slot.tsx';
import { rank, type Ranked } from './match.ts';

const DEEP_PAUSE_MS = 160;

export default function Palette(_p: { readonly client: PluginClient; readonly params: unknown }): JSX.Element {
  const shell = useShell();
  const host = useClients();
  const sources = useSignal(host.palette);
  const nav = useSignal(shell.nav);
  const [query, setQuery] = createSignal('');
  const [sel, setSel] = createSignal(0);
  const [deep, setDeep] = createSignal<{ q: string; items: readonly PaletteItem[] }>({ q: '', items: [] });
  const scope = shell.client.scope.child('palette');
  onCleanup(() => scope.dispose());

  const ctxFor = (plugin: string): PaletteContext => {
    const n = nav();
    const focused = shell.selection.get() ?? (n.main.kind === 'task' ? n.main.id : undefined);
    return { client: host.client(plugin), nav: n, focused };
  };
  const items = createMemo(() =>
    sources().flatMap((s) => {
      try {
        return s.items(ctxFor(s.plugin));
      } catch {
        return [];
      }
    }),
  );
  const shown = createMemo<Ranked[]>(() => {
    const q = query();
    const d = deep();
    return rank(items(), q, scope.timers.now(), d.q === q.trim() ? d.items : []);
  });

  let cancelAsk: (() => void) | undefined;
  let asking: AbortController | undefined;
  const ask = (q: string): void => {
    cancelAsk?.();
    asking?.abort();
    const words = q.trim();
    if (words.length < 3 || words.startsWith('#')) return;
    cancelAsk = scope.timeout(DEEP_PAUSE_MS, () => {
      const ctl = new AbortController();
      asking = ctl;
      scope.add(() => ctl.abort());
      const all = sources()
        .filter((s) => s.deep)
        .map((s) => s.deep?.(words, ctxFor(s.plugin), ctl.signal).catch(() => []) ?? Promise.resolve([]));
      void Promise.all(all).then((lists) => {
        if (ctl.signal.aborted || query().trim() !== words) return;
        setDeep({ q: words, items: lists.flat() });
      });
    });
  };

  const run = (r: Ranked | undefined): void => {
    if (!r) return;
    if (r.item.fill !== undefined) {
      setQuery(r.item.fill);
      setSel(0);
      return;
    }
    shell.navigate({ t: 'closeOverlay', id: 'shell.palette' as never });
    r.item.run?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    const n = shown().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n === 0) return;
      setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      document.getElementById(`palette-row-${sel()}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      run(shown()[sel()]);
    }
  };
  const headAt = (i: number): string | undefined => {
    const cur = shown()[i]?.item.group;
    return i === 0 || shown()[i - 1]?.item.group !== cur ? cur : undefined;
  };

  return (
    <Stack gap="3" part="shell.palette">
      <Input
        type="search"
        icon="search"
        autofocus
        spellcheck={false}
        autocomplete="off"
        value={query()}
        placeholder={shell.t('shell.palette.placeholder')}
        aria-label={shell.t('shell.palette.title')}
        onInput={(v) => {
          setQuery(v);
          setSel(0);
          ask(v);
        }}
        onKeyDown={onKey}
        part="shell.palette.input"
      />
      <Show when={shown().length > 0} fallback={<Text tone="muted" size="sm">{shell.t('shell.palette.empty', { q: query().trim() })}</Text>}>
        <Stack gap="0" role="listbox" aria-label={shell.t('shell.palette.title')} part="shell.palette.list">
          <For each={shown()}>
            {(r, i) => (
              <>
                <Show when={headAt(i())}>{(g) => <Text size="xs" tone="faint" weight="medium" part="shell.palette.group">{g()}</Text>}</Show>
                <ListRow
                  id={`palette-row-${i()}`}
                  part="shell.palette.row"
                  title={r.item.label}
                  lead={<Icon name={(r.item.icon ?? 'arrow') as IconName} size="sm" />}
                  {...(r.item.sub !== undefined && { sub: r.item.sub })}
                  {...(r.item.kbd !== undefined && { actions: <Kbd keys={r.item.kbd.split(' ')} /> })}
                  selected={sel() === i()}
                  onOpen={() => run(r)}
                />
              </>
            )}
          </For>
        </Stack>
      </Show>
      <Text size="xs" tone="faint" part="shell.palette.foot">
        <Kbd keys={['↑', '↓']} /> {shell.t('shell.palette.navigate')} · <Kbd keys={['↵']} /> {shell.t('shell.palette.open')} · <Kbd keys={['esc']} /> {shell.t('shell.palette.close')}
      </Text>
    </Stack>
  );
}
