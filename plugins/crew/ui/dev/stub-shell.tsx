// A stub of the shell's extension host, for this plugin's dev page: it renders what the plugin
// attaches to the shell's inputs (list sections, the crew rail and page, the open task's band and
// composer) and its views (main and overlays), the way packages/shell will. Dev-only; replaced by
// `npm run dev:web` once apps/web exists.

import { Show, createMemo, onCleanup, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { Json, Nav } from '@wisp/client';
import type { ExtensionDef, InputId, PluginUiDef, ViewDef } from '@wisp/shell/contract';
import { Box, Dialog, ExtensionSlot, Heading, Inline, KitProvider, Scroll, Stack, Text, Toasts, createToaster, englishT, useSignal, type ExtensionOutput, type Toaster } from '@wisp/ui';
import type { Harness } from './harness.ts';

export interface StubShellProps {
  readonly h: Harness;
  readonly def: PluginUiDef;
  readonly toaster: Toaster;
  /** the open task's row kind and id prefix, for task-scoped inputs */
  readonly sessionKind?: string;
}

export function devToaster(): Toaster {
  return createToaster();
}

function outputs(p: StubShellProps, input: InputId, extra: Record<string, unknown> = {}): ExtensionOutput[] {
  const defs: readonly ExtensionDef[] = p.def.extensions ?? [];
  return defs
    .filter((d) => d.attachTo.id === input)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((d) => {
      const props = { client: p.h.plugin, config: d.config?.default ?? {}, ...extra };
      return { id: d.id, render: () => <Show when={!d.if || d.if(props)}>{<Dynamic component={d.component} {...props} />}</Show> };
    });
}

function viewFor(p: StubShellProps, id: string): ViewDef | undefined {
  return (p.def.views ?? []).find((v) => v.kind === id);
}

function Slot(props: { readonly p: StubShellProps; readonly input: InputId; readonly extra?: Record<string, unknown>; readonly layout?: 'stack' | 'inline' }): JSX.Element {
  return <ExtensionSlot input={props.input as `${string}.${string}`} layout={props.layout ?? 'stack'} extensions={outputs(props.p, props.input, props.extra)} />;
}

function Sidebar(props: { readonly p: StubShellProps }): JSX.Element {
  return (
    <Stack gap="4">
      <Slot p={props.p} input="shell.list:top" />
      <Slot p={props.p} input="shell.list:feedTop" />
      <Slot p={props.p} input="shell.list:needs" />
      <Slot p={props.p} input="shell.list:working" />
      <Slot p={props.p} input="shell.list:scheduled" />
      <Slot p={props.p} input="shell.list:drafts" />
    </Stack>
  );
}

function TaskMain(props: { readonly p: StubShellProps; readonly id: string }): JSX.Element {
  const row = useSignal(props.p.h.client.entities.row<{ id: string; agent: string; title?: string }>(props.p.sessionKind ?? 'session', props.id as never));
  const session = (): { id: string; agent: string; [k: string]: unknown } | undefined => row() as { id: string; agent: string } | undefined;
  return (
    <Stack gap="4" pad="5">
      <Slot p={props.p} input="shell.task:head" extra={{ session }} layout="inline" />
      <Heading level={2}>{row()?.title ?? props.id}</Heading>
      <Slot p={props.p} input="shell.task:band" extra={{ session }} />
      <Slot p={props.p} input="shell.task:upcoming" extra={{ session }} />
      <Box pad="4" border="line" radius="md">
        <Text tone="muted">{'(transcript)'}</Text>
      </Box>
      <Slot p={props.p} input="shell.composer:chips" extra={{ session }} layout="inline" />
      <Slot p={props.p} input="shell.composer:bar" extra={{ session }} layout="inline" />
    </Stack>
  );
}

function Main(props: { readonly p: StubShellProps; readonly nav: Nav }): JSX.Element {
  const m = (): Nav['main'] => props.nav.main;
  return (
    <Show when={m().kind !== 'home'} fallback={<Stack pad="5" gap="4"><Slot p={props.p} input="shell.plan:page" /></Stack>}>
      <Show when={m().kind === 'task' && (m() as { id: string }).id} keyed>
        {(id) => <TaskMain p={props.p} id={id} />}
      </Show>
      <Show when={m().kind === 'crew' && (m() as { id: string }).id} keyed>
        {(id) => <Slot p={props.p} input="shell.screen:crew" extra={{ id }} />}
      </Show>
      <Show when={m().kind === 'view' && (m() as { id: string; params: Json })} keyed>
        {(v: { id: string; params: Json }) => <Show when={viewFor(props.p, v.id)}>{(def) => <Dynamic component={def().component} client={props.p.h.plugin} params={def().parse(v.params)} />}</Show>}
      </Show>
    </Show>
  );
}

function Overlays(props: { readonly p: StubShellProps; readonly nav: Nav }): JSX.Element {
  const top = createMemo(() => props.nav.overlays.at(-1));
  return (
    <Show when={top()} keyed>
      {(o) => (
        <Show when={viewFor(props.p, o.id)}>
          {(def) => (
            <Dialog open title={def().title?.(def().parse(o.params)) ?? o.id} size="lg" onOpenChange={(open) => !open && props.p.h.client.nav.navigate({ t: 'closeOverlay' })}>
              <Dynamic component={def().component} client={props.p.h.plugin} params={def().parse(o.params)} />
            </Dialog>
          )}
        </Show>
      )}
    </Show>
  );
}

export function StubShell(props: StubShellProps): JSX.Element {
  const p = props;
  for (const v of p.def.views ?? []) {
    p.h.plugin.registerView({
      id: v.kind,
      slot: v.slot,
      parse: (x) => {
        try {
          return v.parse(x) as Json;
        } catch {
          return undefined;
        }
      },
    });
  }
  if (p.def.catalogue) p.h.plugin.strings(p.def.catalogue);
  p.def.setup?.(p.h.plugin);
  const nav = useSignal(p.h.client.nav.nav);
  const onResize = (): void => p.h.client.nav.navigate({ t: 'resize', width: window.innerWidth });
  window.addEventListener('resize', onResize);
  onCleanup(() => window.removeEventListener('resize', onResize));
  onResize();
  const split = (): boolean => nav().layout === 'split';
  return (
    <KitProvider t={englishT}>
      <Box part="dev.shell" surface="bg" vars={{ '--sb-w': '320px' }}>
        <Show
          when={split()}
          fallback={
            <Scroll axis="y">
              <Show when={nav().main.kind === 'home'} fallback={<Main p={p} nav={nav()} />}>
                <Box pad="3">
                  <Sidebar p={p} />
                </Box>
              </Show>
            </Scroll>
          }
        >
          <Inline gap="0" align="start">
            <Slot p={p} input="shell.crew:rail" />
            <Box part="dev.sidebar" pad="3" surface="rail" border="line" vars={{ '--dev-w': '320px' }}>
              <Sidebar p={p} />
            </Box>
            <Box part="dev.main" grow>
              <Main p={p} nav={nav()} />
            </Box>
          </Inline>
        </Show>
        <Overlays p={p} nav={nav()} />
        <Toasts toaster={p.toaster} />
      </Box>
    </KitProvider>
  );
}

/** ?theme=light|dark */
export function applyTheme(): void {
  const theme = new URLSearchParams(window.location.search).get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
}

