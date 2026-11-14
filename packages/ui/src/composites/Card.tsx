// Card: a surface with a hairline border (v1's .card). Header and footer sit on their own rows,
// split from the body by a line, so the parts of cards in a grid line up.
import { Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { Space, Tone } from '@wisp/tokens';
import { spaceVar } from '@wisp/tokens';
import { flag, styleOf, sub, type KitProps, type Labelled, type PartName, type WithChildren, type WithVars } from '../core/props.ts';

export interface CardProps extends KitProps, WithVars, WithChildren, Labelled {
  readonly header?: JSX.Element;
  readonly footer?: JSX.Element;
  /** Padding of each section (default 7: 16px). */
  readonly pad?: Space;
  /** Emphasis on the full 1px border, mixed from the tone; never a side stripe. */
  readonly tone?: Tone;
  /** Hover firms the border: the card opens something. With `onClick` it is a button. */
  readonly interactive?: boolean;
  readonly onClick?: (e: MouseEvent) => void;
  readonly as?: 'div' | 'article' | 'section' | 'li';
}

export function Card(props: CardProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.card';
  const button = (): boolean => props.onClick !== undefined;
  return (
    <Dynamic
      component={button() ? 'button' : (props.as ?? 'div')}
      type={button() ? 'button' : undefined}
      onClick={(e: MouseEvent) => props.onClick?.(e)}
      id={props.id}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      data-kit="card"
      data-part={part()}
      data-tone={props.tone}
      data-interactive={flag(props.interactive === true || button())}
      style={styleOf({ '--k-card-pad': spaceVar(props.pad ?? '7') }, props.vars)}
    >
      <Show when={props.header}>
        <div data-kit="card-header" data-part={sub(part(), 'header')}>{props.header}</div>
      </Show>
      <div data-kit="card-body" data-part={sub(part(), 'body')}>{props.children}</div>
      <Show when={props.footer}>
        <div data-kit="card-footer" data-part={sub(part(), 'footer')}>{props.footer}</div>
      </Show>
    </Dynamic>
  );
}
