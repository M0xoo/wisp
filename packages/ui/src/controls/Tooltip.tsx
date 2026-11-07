// Tooltip: a short label on hover or keyboard focus. It wraps its children in a span that carries
// the trigger props; Zag's Solid adapter turns onFocus/onBlur into focusin/focusout, which bubble
// from the focused child, so keyboard focus opens it too.
import * as tooltip from '@zag-js/tooltip';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';

export interface TooltipProps extends KitProps, WithChildren {
  readonly content: string;
  /** A second, quieter line. */
  readonly hint?: string;
  readonly placement?: 'top' | 'bottom' | 'left' | 'right';
  /** ms before it shows (default 400). */
  readonly openDelay?: number;
  readonly disabled?: boolean;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const id = createUniqueId();
  const service = useMachine(tooltip.machine, () => ({
    id,
    openDelay: props.openDelay ?? 400,
    closeDelay: 100,
    positioning: { placement: props.placement ?? 'top', gutter: 6 },
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
  }));
  const api = createMemo(() => tooltip.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.tooltip';
  // Zag types the trigger as a button; its props (pointer, focus, aria) are as valid on a span.
  const trigger = (): JSX.HTMLAttributes<HTMLSpanElement> => api().getTriggerProps() as JSX.HTMLAttributes<HTMLSpanElement>;
  return (
    <>
      <span {...trigger()} data-kit="tooltip-trigger" data-part={sub(part(), 'trigger')}>
        {props.children}
      </span>
      <Show when={api().open}>
        <Portal>
          <div {...api().getPositionerProps()} data-kit="tooltip-positioner">
            <div {...api().getContentProps()} data-kit="tooltip" data-part={part()}>
              <span>{props.content}</span>
              <Show when={props.hint}>{(hint) => <span data-kit="tooltip-hint">{hint()}</span>}</Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
