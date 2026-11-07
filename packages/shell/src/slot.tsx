// Rendering resolved extensions: one at a time (ExtView, which applies `if` against the render's
// props), a whole input as a kit ExtensionSlot (Slot), or the one extension that fills an area
// (Area: the last one registered, so an override or a later plugin replaces the screen).

import { Show, createContext, createMemo, useContext, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { PluginClient, Readable } from '@wisp/client';
import { ExtensionSlot, useSignal } from '@wisp/ui';
import type { ExtensionProps, PaletteSourceDef, ResolvedExtension, ShortcutDef } from './contract.ts';
import { useShell } from './context.tsx';

/** Which PluginClient an extension of `plugin` gets: provided by the shell's render. */
/** What the shell's own screens need from the host beyond ShellContext (not part of the contract). */
export interface Clients {
  client(plugin: string): PluginClient;
  /** the plugin that registered a view kind */
  viewOwner(kind: string): string | undefined;
  readonly palette: Readable<readonly (PaletteSourceDef & { plugin: string })[]>;
  readonly shortcuts: Readable<readonly (ShortcutDef & { plugin: string })[]>;
}
const ClientsCtx = createContext<Clients>();
export const ClientsProvider = ClientsCtx.Provider;
export function useClients(): Clients {
  const c = useContext(ClientsCtx);
  if (!c) throw new Error('usePluginClient outside the shell');
  return c;
}
export function usePluginClient(plugin: string): PluginClient {
  return useClients().client(plugin);
}
export function useViewClient(kind: string): PluginClient {
  const c = useClients();
  return c.client(c.viewOwner(kind) ?? 'shell');
}

export interface Scoped {
  readonly session?: ExtensionProps['session'];
  readonly id?: string;
  readonly form?: 'full' | 'icon';
}

export function extensionProps(ext: ResolvedExtension, client: PluginClient, s: Scoped): ExtensionProps {
  return {
    client,
    config: ext.config,
    ...(s.session && { session: s.session }),
    ...(s.id !== undefined && { id: s.id }),
    ...(s.form && { form: s.form }),
  };
}

export function ExtView(props: { readonly ext: ResolvedExtension } & Scoped): JSX.Element {
  const client = usePluginClient(props.ext.plugin);
  const p = createMemo(() => extensionProps(props.ext, client, props));
  const shown = (): boolean => {
    const test = props.ext.def.if;
    if (!test) return true;
    try {
      return test(p());
    } catch {
      return false;
    }
  };
  return (
    <Show when={shown()}>
      <Dynamic component={props.ext.def.component} {...p()} />
    </Show>
  );
}

export function useExtensions(input: string): () => readonly ResolvedExtension[] {
  return useSignal(useShell().extensions(input));
}

/** Every extension on one input, in order, each isolated by an error boundary. */
export function Slot(props: { readonly input: `${string}.${string}`; readonly layout?: 'inline' | 'wrap' | 'stack' | 'contents' } & Scoped): JSX.Element {
  const list = useExtensions(props.input);
  const shell = useShell();
  const outputs = createMemo(() => list().map((ext) => ({ id: ext.id, render: () => <ExtView ext={ext} {...props} /> })));
  return (
    <ExtensionSlot
      input={props.input}
      extensions={outputs()}
      layout={props.layout ?? 'inline'}
      onError={(id, err) => shell.client.devtools.record({ kind: 'warn', message: `${id} failed: ${String(err)}` })}
    />
  );
}

/** The one extension that fills an area: the last registered (an override, or a later plugin). */
export function Area(props: { readonly input: string; readonly fallback: JSX.Element } & Scoped): JSX.Element {
  const list = useExtensions(props.input);
  const last = createMemo(() => list().at(-1));
  return (
    <Show when={last()} keyed fallback={props.fallback}>
      {(ext) => <ExtView ext={ext} {...props} />}
    </Show>
  );
}
