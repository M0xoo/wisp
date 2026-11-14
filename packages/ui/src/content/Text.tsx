// Text, Heading, Kbd and Link: type from the scale only (design/ui.md: at most five sizes a screen).
import { Dynamic } from 'solid-js/web';
import type { JSX } from 'solid-js';
import type { FontSize, FontWeight, InkColor, Tone } from '@wisp/tokens';
import { flag, type KitProps, type WithChildren } from '../core/props.ts';

/** Text colour: one of the inks, or a tone (state colours, for meaning only). */
export type TextTone = InkColor | Tone | 'accent-ink';

export interface TextProps extends KitProps, WithChildren {
  readonly as?: 'span' | 'p' | 'div' | 'strong' | 'em' | 'small' | 'label' | 'figcaption';
  readonly size?: FontSize;
  readonly weight?: FontWeight;
  readonly tone?: TextTone;
  /** Paths, commands, branches, cron, tokens. */
  readonly mono?: boolean;
  /** Numbers that change in place (times, counts) don't wiggle. */
  readonly numeric?: boolean;
  /** One line, ending in `…`. Pass `title` so the full text shows on hover. */
  readonly truncate?: boolean;
  /** At most this many lines, ending in `…` (titles get two on phones). */
  readonly lines?: 2 | 3;
  /** Short labels stay whole: no wrapping, no shrinking. */
  readonly nowrap?: boolean;
  /** Long URLs and unbroken words break instead of running off the card. */
  readonly breakAnywhere?: boolean;
  readonly align?: 'start' | 'center' | 'end';
  readonly title?: string;
  /** For `as="label"`. */
  readonly for?: string;
}

export function Text(props: TextProps): JSX.Element {
  return (
    <Dynamic
      component={props.as ?? 'span'}
      id={props.id}
      title={props.title}
      for={props.for}
      data-kit="text"
      data-part={props.part ?? 'ui.text'}
      data-size={props.size}
      data-weight={props.weight}
      data-tone={props.tone}
      data-mono={flag(props.mono)}
      data-numeric={flag(props.numeric)}
      data-truncate={flag(props.truncate)}
      data-lines={props.lines}
      data-nowrap={flag(props.nowrap)}
      data-break={flag(props.breakAnywhere)}
      data-align={props.align}
    >
      {props.children}
    </Dynamic>
  );
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingProps extends KitProps, WithChildren {
  readonly level?: HeadingLevel;
  /** Defaults by level: 1 display, 2 title, 3 lg, 4–6 md. */
  readonly size?: FontSize;
  readonly tone?: InkColor;
  readonly lines?: 2 | 3;
}

const HEADING_SIZE: Readonly<Record<HeadingLevel, FontSize>> = { 1: 'display', 2: 'title', 3: 'lg', 4: 'md', 5: 'md', 6: 'md' };

export function Heading(props: HeadingProps): JSX.Element {
  const level = (): HeadingLevel => props.level ?? 2;
  return (
    <Dynamic
      component={`h${level()}`}
      id={props.id}
      data-kit="heading"
      data-part={props.part ?? 'ui.heading'}
      data-size={props.size ?? HEADING_SIZE[level()]}
      data-tone={props.tone}
      data-lines={props.lines}
    >
      {props.children}
    </Dynamic>
  );
}

export interface KbdProps extends KitProps {
  /** One key or chord per entry: `['⌘', 'K']`. */
  readonly keys: readonly string[];
  /** in a sentence: the keys sit in the line (v1 `… or <kbd>V</kbd>`), not in a box of their own. Additive. */
  readonly inline?: boolean;
}

/** Keyboard keys. Hidden on touch screens, where there's no keyboard to press them on. */
export function Kbd(props: KbdProps): JSX.Element {
  return (
    <span data-kit="kbd-group" data-part={props.part ?? 'ui.kbd'} id={props.id} data-inline={props.inline ? '' : undefined}>
      {props.keys.map((k) => (
        <kbd data-kit="kbd">{k}</kbd>
      ))}
    </span>
  );
}

export interface LinkProps extends KitProps, WithChildren {
  readonly href: string;
  /** Opens in a new tab, without the opener. */
  readonly external?: boolean;
  /** In-app navigation: the handler gets the event and may preventDefault. */
  readonly onClick?: (e: MouseEvent) => void;
  readonly tone?: 'accent' | 'ink' | 'muted';
  readonly title?: string;
}

export function Link(props: LinkProps): JSX.Element {
  return (
    <a
      href={props.href}
      id={props.id}
      title={props.title}
      target={props.external ? '_blank' : undefined}
      rel={props.external ? 'noopener noreferrer' : undefined}
      onClick={(e) => props.onClick?.(e)}
      data-kit="link"
      data-part={props.part ?? 'ui.link'}
      data-tone={props.tone ?? 'accent'}
    >
      {props.children}
    </a>
  );
}
