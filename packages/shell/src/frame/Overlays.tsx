// The overlay stack from navigation (plan §4.6.4): each overlay is a registered view drawn in a kit
// Dialog, a card on phones too, as v1's modals were; a viewer fills a phone, and a `sheet` comes up from the bottom. Closing one, by its X, a click outside or Esc, is the
// closeOverlay intent for its id, so the URL, Back and an Open on a toast all agree (#573). Keyed by
// id: reopening the same overlay never rebuilds it while it stays up.

import { For, Show, createMemo, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { ExtensionId, Overlay } from '@wisp/client';
import { Dialog, EmptyState, Sheet, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { useViewClient } from '../slot.tsx';

function OverlayView(props: { readonly overlay: Overlay }): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const def = shell.view(props.overlay.id);
  const client = useViewClient(props.overlay.id);
  const params = (): unknown => (def ? def.parse(props.overlay.params) : undefined);
  const close = (open: boolean): void => {
    if (!open) shell.navigate({ t: 'closeOverlay', id: props.overlay.id as ExtensionId });
  };
  const title = (): string => (def?.title ? def.title(params()) : shell.t('shell.palette.title'));
  const body = (): JSX.Element => (def ? <Dynamic component={def.component} client={client} params={params()} /> : <EmptyState icon="info" title={shell.t('shell.view.missing')} compact />);
  // a text field inside takes the focus first (the palette's search), else the kit's default
  const initialFocus = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-part~="shell.overlay"] input, [data-part~="shell.overlay"] textarea');
  // v1's modals stay cards on a phone (a 20px inset, scrolled inside); a viewer (Settings) takes the phone's whole
  // screen as before, and what's opened as a sheet comes up from the bottom; never a view placed at the top (⌘K)
  const sheet = (): boolean => def?.place !== 'top' && (props.overlay.kind === 'sheet' || (props.overlay.kind === 'viewer' && nav().layout === 'stack'));
  return (
    <Show
      when={sheet()}
      fallback={
        <Dialog
          open
          title={title()}
          bare={def?.bare === true}
          {...(def?.place && { place: def.place })}
          onOpenChange={close}
          initialFocus={initialFocus}
          size={props.overlay.kind === 'viewer' ? 'xl' : (def?.size ?? 'md')}
          part={(def?.part ? `shell.overlay ${def.part}` : 'shell.overlay') as `${string}.${string}`}
        >
          {body()}
        </Dialog>
      }
    >
      <Sheet
        open
        title={title()}
        bare={def?.bare === true}
        onOpenChange={close}
        initialFocus={initialFocus}
        {...(props.overlay.kind === 'viewer' && { size: 'xl' as const })}
        part={(def?.part ? `shell.overlay ${def.part}` : 'shell.overlay') as `${string}.${string}`}
      >
        {body()}
      </Sheet>
    </Show>
  );
}

export function Overlays(): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const ids = createMemo(() => nav().overlays.map((o) => o.id), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const byId = (id: string): Overlay | undefined => nav().overlays.find((o) => o.id === id);
  return <For each={ids()}>{(id) => <Show when={byId(id)}>{(o) => <OverlayView overlay={o()} />}</Show>}</For>;
}
