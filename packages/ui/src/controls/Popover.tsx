// Popover: a floating card anchored to its button. Outside click and Escape close it and put
// focus back on the button (design/ux.md).
import * as popover from '@zag-js/popover';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { styleOf, sub, type KitProps, type PartName, type WithChildren, type WithVars } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { Icon } from '../content/Icon.tsx';
import type { MenuTrigger, Placement } from './Menu.tsx';
import { TriggerButton } from './trigger.tsx';

export interface PopoverProps extends KitProps, WithChildren, WithVars {
  readonly trigger: MenuTrigger;
  /** A heading inside the card; with one, the card also gets a close button. */
  readonly title?: string;
  readonly placement?: Placement;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Keep focus inside while open (for small forms). */
  readonly modal?: boolean;
  readonly t?: Translate;
}

export function Popover(props: PopoverProps): JSX.Element {
  const t = useT(() => props.t);
  const id = createUniqueId();
  const service = useMachine(popover.machine, () => ({
    id,
    ...(props.open === undefined ? {} : { open: props.open }),
    onOpenChange: (d: popover.OpenChangeDetails) => props.onOpenChange?.(d.open),
    positioning: { placement: props.placement ?? 'bottom-start', gutter: 6 },
    ...(props.modal === undefined ? {} : { modal: props.modal }),
  }));
  const api = createMemo(() => popover.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.popover';
  return (
    <>
      <TriggerButton look={props.trigger} bind={api().getTriggerProps()} part={sub(part(), 'trigger')} />
      <Portal>
        <div {...api().getPositionerProps()} data-kit="positioner">
          <div {...api().getContentProps()} data-kit="popover" data-part={part()} style={styleOf({}, props.vars)}>
            <Show when={props.title}>
              {(title) => (
                <div data-kit="popover-head">
                  <div {...api().getTitleProps()} data-kit="popover-title" data-part={sub(part(), 'title')}>
                    {title()}
                  </div>
                  <button {...api().getCloseTriggerProps()} aria-label={t('close')} title={t('close')} data-kit="icon-button" data-variant="ghost" data-size="xs">
                    <Icon name="x" size="sm" />
                  </button>
                </div>
              )}
            </Show>
            <div data-kit="popover-body" data-part={sub(part(), 'body')}>
              {props.children}
            </div>
          </div>
        </div>
      </Portal>
    </>
  );
}
