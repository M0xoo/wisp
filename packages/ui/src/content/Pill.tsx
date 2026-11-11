// Pill: a short state or tag (v1's .pill): a soft fill of its tone, an optional dot or icon.
// Colour means state (done, waiting, error), never decoration.
import { Show, type JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { flag, type KitProps, type WithChildren } from '../core/props.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface PillProps extends KitProps, WithChildren {
  readonly tone?: Tone;
  /** A small dot in the tone before the text. */
  readonly dot?: boolean;
  /** Pulse the dot: something is live. Stilled under reduced motion. */
  readonly live?: boolean;
  readonly icon?: IconName;
  /** soft: a tinted fill (states). outline: a hairline border (tags, topics). */
  /** plain: the dot and the word only (v1 Settings → Agents' state) */
  readonly variant?: 'soft' | 'outline' | 'plain';
  readonly title?: string;
}

export function Pill(props: PillProps): JSX.Element {
  return (
    <span
      id={props.id}
      title={props.title}
      data-kit="pill"
      data-part={props.part ?? 'ui.pill'}
      data-tone={props.tone ?? 'neutral'}
      data-variant={props.variant ?? 'soft'}
    >
      <Show when={props.dot}>
        <span data-kit="pill-dot" data-live={flag(props.live)} />
      </Show>
      <Show when={props.icon}>{(name) => <Icon name={name()} size="xs" />}</Show>
      <span data-kit="pill-label" data-text="control">{props.children}</span>
    </span>
  );
}
