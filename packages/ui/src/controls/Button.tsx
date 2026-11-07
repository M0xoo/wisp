// Button and IconButton: v1's .primary / .ghost / .icon-btn, plus a bordered secondary and a red
// danger for confirms. Loading keeps the label in place (hidden) so the width never changes.
import { Show, type JSX } from 'solid-js';
import { flag, type KitProps, type Labelled, type WithChildren } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonBase extends KitProps, Labelled {
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
  /** Busy: a ring replaces the content in place; clicks are ignored; the width holds. */
  readonly loading?: boolean;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly onClick?: (e: MouseEvent) => void;
  /** A toggle button's state (aria-pressed). */
  readonly pressed?: boolean;
  /** Menus and popovers it opens set these. */
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly haspopup?: 'menu' | 'dialog' | 'listbox';
  readonly title?: string;
  readonly t?: Translate;
  readonly ref?: (el: HTMLButtonElement) => void;
}

export interface ButtonProps extends ButtonBase, WithChildren {
  readonly variant?: ButtonVariant;
  /** Colours a ghost button's text: green for Mark done, red for a quiet destructive action. */
  readonly tone?: 'good' | 'bad';
  readonly icon?: IconName;
  readonly iconEnd?: IconName;
  /** A shortcut hint shown inside the button (hidden on touch). */
  readonly kbd?: string;
  /** Fill the width of its container. */
  readonly fill?: boolean;
}

function Spinner(props: { readonly label: string }): JSX.Element {
  return <span data-kit="spinner" role="status" aria-label={props.label} />;
}

export function Button(props: ButtonProps): JSX.Element {
  const t = useT(() => props.t);
  return (
    <button
      ref={props.ref}
      id={props.id}
      type={props.type ?? 'button'}
      disabled={props.disabled}
      aria-disabled={props.loading ? 'true' : undefined}
      aria-busy={props.loading ? 'true' : undefined}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded}
      aria-controls={props.controls}
      aria-haspopup={props.haspopup}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      title={props.title}
      onClick={(e) => {
        if (props.loading) return;
        props.onClick?.(e);
      }}
      data-kit="button"
      data-part={props.part ?? 'ui.button'}
      data-variant={props.variant ?? 'secondary'}
      data-size={props.size ?? 'md'}
      data-tone={props.tone}
      data-loading={flag(props.loading)}
      data-fill={flag(props.fill)}
    >
      <span data-kit="button-content">
        <Show when={props.icon}>{(name) => <Icon name={name()} size={props.size === 'xs' ? 'sm' : 'md'} />}</Show>
        <Show when={props.children !== undefined}>
          <span data-kit="button-label">{props.children}</span>
        </Show>
        <Show when={props.iconEnd}>{(name) => <Icon name={name()} size="sm" />}</Show>
        <Show when={props.kbd}>{(k) => <kbd data-kit="kbd">{k()}</kbd>}</Show>
      </span>
      <Show when={props.loading}>
        <Spinner label={t('loading')} />
      </Show>
    </button>
  );
}

export interface IconButtonProps extends ButtonBase {
  readonly icon: IconName;
  /** Required: an icon-only button needs a name (aria-label and title). */
  readonly label: string;
  readonly variant?: 'ghost' | 'secondary' | 'primary';
  readonly tone?: 'good' | 'bad';
}

/** A square button with an icon and no text; `label` is its accessible name and tooltip. */
export function IconButton(props: IconButtonProps): JSX.Element {
  const t = useT(() => props.t);
  return (
    <button
      ref={props.ref}
      id={props.id}
      type={props.type ?? 'button'}
      disabled={props.disabled}
      aria-label={props.label}
      aria-busy={props.loading ? 'true' : undefined}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded}
      aria-controls={props.controls}
      aria-haspopup={props.haspopup}
      title={props.title ?? props.label}
      onClick={(e) => {
        if (props.loading) return;
        props.onClick?.(e);
      }}
      data-kit="icon-button"
      data-part={props.part ?? 'ui.icon-button'}
      data-variant={props.variant ?? 'ghost'}
      data-size={props.size ?? 'md'}
      data-tone={props.tone}
      data-loading={flag(props.loading)}
    >
      <span data-kit="button-content">
        <Icon name={props.icon} size={props.size === 'xs' || props.size === 'sm' ? 'md' : 'base'} />
      </span>
      <Show when={props.loading}>
        <Spinner label={t('loading')} />
      </Show>
    </button>
  );
}
