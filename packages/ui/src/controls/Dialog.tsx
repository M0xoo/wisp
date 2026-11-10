// Dialog and Sheet on Zag's dialog machine: focus moves in and is trapped, Escape and the
// backdrop close it, focus returns to what opened it, the page behind doesn't scroll. It opens in
// its final shape at once (design/ux.md): the caller shows placeholders for what still loads.
import * as dialog from '@zag-js/dialog';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { styleOf, sub, type KitProps, type PartName, type WithChildren, type WithVars } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { Icon } from '../content/Icon.tsx';
import type { MenuTrigger } from './Menu.tsx';
import { TriggerButton } from './trigger.tsx';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps extends KitProps, WithChildren, WithVars {
  readonly title: string;
  readonly description?: string;
  /** Buttons along the bottom: Cancel, then the action named for what it does. */
  readonly footer?: JSX.Element;
  /** Controlled: the caller owns whether it's open. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Or let the dialog render its own opening button. */
  readonly trigger?: MenuTrigger;
  /** 400, 600 (default) or 800 wide. */
  readonly size?: DialogSize;
  /** `alertdialog` for a confirm that interrupts. */
  readonly role?: 'dialog' | 'alertdialog';
  /** Clicking outside closes it (default true; false for a form with unsaved input). */
  readonly closeOnOutside?: boolean;
  /** the content brings its own head and close (a frame like Settings): the title stays for screen readers only */
  readonly bare?: boolean;
  /** Where focus goes first (default: the first focusable inside). */
  readonly initialFocus?: () => HTMLElement | null;
  readonly t?: Translate;
}

type Kind = 'dialog' | 'sheet';

function useDialog(props: DialogProps): () => dialog.Api {
  const id = createUniqueId();
  const service = useMachine(dialog.machine, () => ({
    id,
    ...(props.open === undefined ? {} : { open: props.open }),
    onOpenChange: (d: dialog.OpenChangeDetails) => props.onOpenChange?.(d.open),
    role: props.role ?? 'dialog',
    closeOnInteractOutside: props.closeOnOutside ?? true,
    ...(props.initialFocus ? { initialFocusEl: props.initialFocus } : {}),
  }));
  return createMemo(() => dialog.connect(service, normalizeProps));
}

function Surface(props: DialogProps & { readonly kind: Kind; readonly api: dialog.Api; readonly part: PartName }): JSX.Element {
  const t = useT(() => props.t);
  return (
    <Portal>
      <div {...props.api.getBackdropProps()} data-kit="backdrop" data-sheet={props.kind === 'sheet' ? '' : undefined} />
      <div {...props.api.getPositionerProps()} data-kit="dialog-positioner" data-sheet={props.kind === 'sheet' ? '' : undefined}>
        <div
          {...props.api.getContentProps()}
          data-kit={props.kind}
          data-part={props.part}
          data-size={props.size ?? 'md'}
          data-bare={props.bare ? '' : undefined}
          style={styleOf({}, props.vars)}
        >
          <Show when={props.kind === 'sheet'}>
            <span data-kit="sheet-handle" aria-hidden="true" />
          </Show>
          <header data-kit="dialog-head" data-part={sub(props.part, 'head')}>
            <h2 {...props.api.getTitleProps()} data-kit="dialog-title" data-part={sub(props.part, 'title')}>
              {props.title}
            </h2>
            <button
              {...props.api.getCloseTriggerProps()}
              aria-label={t('close')}
              title={t('close')}
              data-kit="icon-button"
              data-variant="ghost"
              data-size="sm"
              data-part={sub(props.part, 'close')}
            >
              <Icon name="x" size="md" />
            </button>
          </header>
          <Show when={props.description}>
            {(text) => (
              <p {...props.api.getDescriptionProps()} data-kit="dialog-description">
                {text()}
              </p>
            )}
          </Show>
          <div data-kit="dialog-body" data-part={sub(props.part, 'body')}>
            {props.children}
          </div>
          <Show when={props.footer}>
            <footer data-kit="dialog-foot" data-part={sub(props.part, 'foot')}>
              {props.footer}
            </footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

function Shell(props: DialogProps & { readonly kind: Kind }): JSX.Element {
  const api = useDialog(props);
  const part = (): PartName => props.part ?? (props.kind === 'sheet' ? 'ui.sheet' : 'ui.dialog');
  return (
    <>
      <Show when={props.trigger}>
        {(look) => <TriggerButton look={look()} bind={api().getTriggerProps()} part={sub(part(), 'trigger')} />}
      </Show>
      <Show when={api().open}>
        <Surface {...props} api={api()} part={part()} />
      </Show>
    </>
  );
}

/** A centred card over a dimmed page. */
export function Dialog(props: DialogProps): JSX.Element {
  return <Shell {...props} kind="dialog" />;
}

/** On phones a sheet from the bottom with a grab handle; from the phone breakpoint up, a card. */
export function Sheet(props: DialogProps): JSX.Element {
  return <Shell {...props} kind="sheet" />;
}
