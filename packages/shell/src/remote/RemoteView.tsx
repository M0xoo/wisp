// The remote view host (ADR-0048): an untrusted plugin's UI module runs in a Worker inside a sandboxed, hidden frame
// (frame.ts); what it sends is checked (descriptor.ts) and drawn with the kit, so it looks like wisp and can't draw
// anything else. Its `wisp.call(cmd, args)` goes out as the plugin itself (`x-wisp-plugin`: the edge checks it
// against the plugin's own permissions, never the user's); an event on a node it named goes back by that name.
import { Index, Match, Show, Switch as Case, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Button, Callout, Code, Inline, Input, ListRow, Markdown, Select, SettingsRow, Stack, Switch, Text } from '@wisp/ui';
import { clean, type Desc, type Node } from './descriptor.ts';
import { SANDBOX, frameDoc } from './frame.ts';

type Fire = (on: string | undefined, value?: unknown) => void;

const str = (d: Desc, k: string): string => (typeof d.p[k] === 'string' ? (d.p[k] as string) : '');
const bool = (d: Desc, k: string): boolean => d.p[k] === true;
// the descriptor checked each value against the kit's own list: these casts only name the type it already is
const pick = <T,>(d: Desc, k: string): T | undefined => d.p[k] as T | undefined;

/** One checked node, drawn with the kit; it follows the plugin's later renders in place. */
export function Render(props: { readonly node: Node; readonly fire: Fire }): JSX.Element {
  // by index: a new render updates each node in place (an input keeps its focus), never rebuilds the tree
  const kids = (d: () => Desc): JSX.Element => <Index each={d().k}>{(n) => <Render node={n()} fire={props.fire} />}</Index>;
  return (
    <Show when={typeof props.node !== 'string' && (props.node as Desc)} fallback={<>{props.node as string}</>}>
      {(get) => {
        const d = get;
        return (
          <Case>
            <Match when={d().c === 'Stack'}>
              <Stack gap={pick(d(), 'gap') ?? '2'} align={pick(d(), 'align') ?? 'stretch'} justify={pick(d(), 'justify') ?? 'start'}>
                {kids(d)}
              </Stack>
            </Match>
            <Match when={d().c === 'Inline'}>
              <Inline gap={pick(d(), 'gap') ?? '2'} align={pick(d(), 'align') ?? 'center'} justify={pick(d(), 'justify') ?? 'start'}>
                {kids(d)}
              </Inline>
            </Match>
            <Match when={d().c === 'Text'}>
              <Text size={pick(d(), 'size') ?? 'md'} weight={pick(d(), 'weight') ?? 'regular'} tone={pick(d(), 'tone') ?? 'ink'} mono={bool(d(), 'mono')} truncate={bool(d(), 'truncate')}>
                {kids(d)}
              </Text>
            </Match>
            <Match when={d().c === 'Button'}>
              <span>
                <Button variant={pick(d(), 'variant') ?? 'secondary'} size={pick(d(), 'size') ?? 'sm'} disabled={bool(d(), 'disabled')} onClick={() => props.fire(d().on)}>
                  {str(d(), 'label')}
                </Button>
              </span>
            </Match>
            <Match when={d().c === 'Input'}>
              <Input
                value={str(d(), 'value')}
                placeholder={str(d(), 'placeholder')}
                type={pick(d(), 'type') ?? 'text'}
                size={pick(d(), 'size') ?? 'sm'}
                aria-label={str(d(), 'label') || str(d(), 'placeholder')}
                onInput={(v) => props.fire(d().on, v)}
              />
            </Match>
            <Match when={d().c === 'Switch'}>
              <Switch checked={bool(d(), 'checked')} label={str(d(), 'label')} disabled={bool(d(), 'disabled')} onChange={(v) => props.fire(d().on, v)} />
            </Match>
            <Match when={d().c === 'Select'}>
              <Select
                items={(pick<readonly { value: string; label: string }[]>(d(), 'items') ?? []).map((i) => ({ value: i.value, label: i.label }))}
                value={str(d(), 'value') || undefined}
                placeholder={str(d(), 'placeholder')}
                aria-label={str(d(), 'label') || str(d(), 'placeholder')}
                onChange={(v) => props.fire(d().on, v)}
              />
            </Match>
            <Match when={d().c === 'SettingsRow'}>
              <SettingsRow
                title={str(d(), 'title')}
                description={str(d(), 'description')}
                control={
                  <Show when={pick<Desc>(d(), 'control')} fallback={<span />}>
                    {(c) => <Render node={c()} fire={props.fire} />}
                  </Show>
                }
              />
            </Match>
            <Match when={d().c === 'ListRow'}>
              <ListRow title={str(d(), 'title')} sub={str(d(), 'sub')} />
            </Match>
            <Match when={d().c === 'Callout'}>
              <Callout tone={pick(d(), 'tone') ?? 'info'} title={str(d(), 'title')}>
                {kids(d)}
              </Callout>
            </Match>
            <Match when={d().c === 'Code'}>
              <Code block={bool(d(), 'block')} lang={str(d(), 'lang')}>
                {str(d(), 'text')}
              </Code>
            </Match>
            <Match when={d().c === 'Markdown'}>
              <Markdown source={str(d(), 'source')} />
            </Match>
          </Case>
        );
      }}
    </Show>
  );
}

/** What the frame says, as the host reads it. */
export type FromFrame = { t: 'ready' } | { t: 'render'; tree: unknown } | { t: 'call'; id: number; cmd: string; args: unknown } | { t: 'error'; message: string };

/** A frame message, or nothing: anything else a frame sends is ignored. */
export function readFrame(m: unknown): FromFrame | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  if (o['t'] === 'ready') return { t: 'ready' };
  if (o['t'] === 'render') return { t: 'render', tree: o['tree'] };
  if (o['t'] === 'call' && typeof o['id'] === 'number' && typeof o['cmd'] === 'string' && /^[\w.:-]{1,128}$/.test(o['cmd'])) return { t: 'call', id: o['id'], cmd: o['cmd'], args: o['args'] ?? {} };
  if (o['t'] === 'error') return { t: 'error', message: String(o['message'] ?? '') };
  return undefined;
}

/** Runs `wisp.call` as the plugin: the app's own connection, with `x-wisp-plugin` so the edge speaks as it. */
export async function callAs(client: PluginClient, plugin: string, cmd: string, args: unknown): Promise<unknown> {
  const key = `remote-${plugin}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const out = (await client
    .http(client.home)
    .send({ method: 'POST', path: '/cmd', contentType: 'application/json', body: JSON.stringify({ cmd, args }), headers: { 'x-wisp-plugin': plugin, 'idempotency-key': key } })) as {
    ok?: boolean;
    result?: unknown;
    message?: string;
  } | null;
  if (out && out.ok === false) throw new Error(out.message ?? 'refused');
  return out?.result;
}

export function RemoteView(props: { readonly client: PluginClient; readonly plugin: string; readonly module: string; readonly title: string }): JSX.Element {
  const [tree, setTree] = createSignal<Node | undefined>();
  const [failed, setFailed] = createSignal('');
  let frame: HTMLIFrameElement | undefined;
  const post = (m: unknown): void => frame?.contentWindow?.postMessage(m, '*');
  const fire: Fire = (on, value) => {
    if (on) post({ t: 'event', on, value });
  };
  const onMessage = (e: MessageEvent): void => {
    if (!frame || e.source !== frame.contentWindow) return; // only this plugin's own frame
    const m = readFrame(e.data);
    if (!m) return;
    if (m.t === 'ready') post({ t: 'load', code: props.module });
    else if (m.t === 'render') setTree(clean(m.tree));
    else if (m.t === 'error') setFailed(m.message || 'error');
    else
      callAs(props.client, props.plugin, m.cmd, m.args).then(
        (value) => post({ t: 'result', id: m.id, ok: true, value }),
        (err: unknown) => post({ t: 'result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  };
  onMount(() => window.addEventListener('message', onMessage));
  onCleanup(() => window.removeEventListener('message', onMessage));
  return (
    <Stack gap="3" part="remote.view">
      <iframe ref={(el) => (frame = el)} hidden sandbox={SANDBOX} title={props.title} srcdoc={frameDoc()} data-part="remote.frame" />
      <Show when={failed()}>{(f) => <Callout tone="bad" title={f()} />}</Show>
      <Show when={tree()}>{(n) => <Render node={n()} fire={fire} />}</Show>
    </Stack>
  );
}
