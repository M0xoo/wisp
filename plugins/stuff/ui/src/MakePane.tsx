// Make a pane (v1 pane-make.js openMakePane): say what it should show or do and an agent writes it into My Stuff, in
// an empty folder of its own (a task of kind `pane`); or start from one of the panes wisp ships (stuff.starters): Add keeps
// it in My Stuff and pins it on Home (the Allow card first when it asks to use wisp; v1 pane-make.js), and the dialog
// closes once it's pinned. Said no to the card: it stays added, and its button pins it. Enter makes it; a refusal brings
// the dialog back with what you typed.
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { entityKey, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Inline, Skeleton, Stack, Text, TextArea } from '@wisp/ui';
import { addStarter, listStarters, makePane } from './commands.ts';
import { useEntries } from './items.ts';
import { PaneCards, pinsOf } from './pins.tsx';
import type { Item } from './types.ts';

export const MAKE_VIEW = 'stuff.make';

/** What Make it sends: the words, trimmed; nothing to make without them. */
export const askOf = (v: string): string | undefined => v.trim() || undefined;

export default function MakePane(props: { readonly client: PluginClient; readonly params: unknown }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const t = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const [text, setText] = createSignal(typeof (props.params as { prefill?: unknown } | null)?.prefill === 'string' ? String((props.params as { prefill: string }).prefill) : '');
  const [adding, setAdding] = createSignal<string | undefined>();
  const [added, setAdded] = createSignal<ReadonlySet<string>>(new Set());
  const [starters] = createResource(() => c.run(listStarters, { peer: c.home }).then((r) => r.starters));
  const close = (): void => c.navigate({ t: 'closeOverlay', id: MAKE_VIEW as never });
  const harness = (): string => shell.harnesses()()[0]?.name ?? '';

  const make = (): void => {
    const prompt = askOf(text());
    if (!prompt) return;
    close();
    c.run(makePane, { peer: c.home, prompt, ext: { 'wisp.stuff': { kind: 'pane' } } })
      .then((r) => {
        shell.toast.show(t('stuff.make.making'), { tone: 'info' });
        c.navigate({ t: 'openTask', id: `${c.home}:${r.id}` as never });
      })
      .catch(() => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: MAKE_VIEW as never, params: { prefill: prompt } } }));
  };
  const pins = pinsOf(c);
  const entries = useEntries(c);
  const [kept, setKept] = createSignal<ReadonlyMap<string, Item>>(new Map());
  const pinIt = async (it: Item): Promise<void> => {
    if (await pins.pin(entityKey(c.home, it.id), it, 'home', [...entries().map((e) => e.it), it])) close();
  };
  const add = (id: string): void => {
    setAdding(id);
    const had = kept().get(id);
    (had ? Promise.resolve(had) : c.run(addStarter, { peer: c.home, id }))
      .then(async (it) => {
        setAdded(new Set([...added(), id]));
        setKept(new Map([...kept(), [id, it]]));
        await pinIt(it);
      })
      .catch(() => undefined)
      .finally(() => setAdding(undefined));
  };

  return (
    <Stack gap="4" part="stuff.make">
      <Text size="sm" tone="muted">
        {t('stuff.make.hint')}
      </Text>
      <TextArea
        value={text()}
        minRows={3}
        maxRows={8}
        autofocus
        aria-label={t('stuff.make.label')}
        placeholder={t('stuff.make.placeholder')}
        onInput={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            make();
          }
        }}
      />
      <Text size="sm" weight="semibold">
        {t('stuff.make.starters')}
      </Text>
      <Show when={!starters.loading} fallback={<Stack gap="2"><Skeleton width="3/4" /><Skeleton width="1/2" /></Stack>}>
        <Show when={!starters.error} fallback={<Text size="sm" tone="muted">{String((starters.error as { message?: string })?.message ?? starters.error)}</Text>}>
          <Stack gap="2" part="stuff.make.list">
            <For each={starters() ?? []}>
              {(s) => (
                <Inline gap="3" justify="between" part="stuff.make.starter">
                  <Stack gap="0">
                    <Text size="sm" weight="medium">
                      {s.name}
                    </Text>
                    <Text size="sm" tone="muted">
                      {s.description}
                    </Text>
                  </Stack>
                  <Button size="sm" variant="ghost" loading={adding() === s.id} aria-label={t(added().has(s.id) ? 'stuff.make.pinOne' : 'stuff.make.addOne', { name: s.name })} onClick={() => add(s.id)}>
                    {t(added().has(s.id) ? 'stuff.make.pin' : 'stuff.make.add')}
                  </Button>
                </Inline>
              )}
            </For>
          </Stack>
        </Show>
      </Show>
      <Inline gap="3" justify="between">
        <Text size="sm" tone="muted">
          {t('stuff.make.runs', { harness: harness() })}
        </Text>
        <Button variant="primary" icon="app" disabled={!askOf(text())} onClick={make} part="stuff.make.go">
          {t('stuff.make.go')}
        </Button>
      </Inline>
      <PaneCards client={c} />
    </Stack>
  );
}
