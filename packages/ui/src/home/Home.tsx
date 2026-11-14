// Home's kit pieces (plugins/shell-home/ui): the reading column Home sits in, a tip (a line that
// opens the guide explaining it), a pinned setup card (what to do before wisp can run a task), and
// the floating New task button of the phone app. Look only: the words and what a click does come
// from the plugin.
import type { JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface HomeColumnProps extends KitProps, WithChildren {
  /** stacked (a phone, a narrow window): Home is a page of its own, edge to edge */
  readonly stacked?: boolean;
}

/** Home's column: centred at the reading width side by side, the full width stacked. */
export function HomeColumn(props: HomeColumnProps): JSX.Element {
  return (
    <div id={props.id} data-kit="home-column" data-part={props.part ?? 'ui.home'} data-stacked={flag(props.stacked)}>
      {props.children}
    </div>
  );
}

export interface TipProps extends KitProps, WithChildren {
  readonly href: string;
  /** a link out (the guide): opens in a new tab, with the external mark */
  readonly onOpen?: (href: string, e: MouseEvent) => void;
}

/** One tip: the spark, its text (content: it may wrap), and the external mark. The whole line is the link. */
export function Tip(props: TipProps): JSX.Element {
  return (
    <a
      id={props.id}
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      data-kit="tip"
      data-part={props.part ?? 'ui.tip'}
      onClick={(e) => props.onOpen?.(props.href, e)}
    >
      <Icon name="spark" size="sm" />
      <span data-kit="tip-text">{props.children}</span>
      <Icon name="external" size="xs" part="ui.tip.go" />
    </a>
  );
}

export interface PinnedCardProps extends KitProps {
  readonly icon: IconName;
  readonly title: string;
  readonly line: string;
  /** the call to action at the end ("Set up", "How to") */
  readonly cta: string;
  readonly onClick: () => void;
}

/** A setup card pinned above the tips: badge, what's missing and why, and where to fix it. */
export function PinnedCard(props: PinnedCardProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.pinned';
  return (
    <button type="button" id={props.id} data-kit="pinned" data-part={part()} onClick={() => props.onClick()}>
      <span data-kit="pinned-badge">
        <Icon name={props.icon} size="md" />
      </span>
      <span data-kit="pinned-text">
        <b data-kit="pinned-title" data-text="control">
          {props.title}
        </b>
        <small data-kit="pinned-line">{props.line}</small>
      </span>
      <span data-kit="pinned-cta" data-part={sub(part(), 'cta')} data-text="control">
        {props.cta}
        <Icon name="arrow" size="sm" />
      </span>
    </button>
  );
}

export interface FabProps extends KitProps {
  readonly icon: IconName;
  readonly label: string;
  readonly onClick: () => void;
  /** something with choices is on screen under it: it fades and sinks out of reach, and comes back */
  readonly giveWay?: boolean;
}

/** The floating button over a phone's list (v1 fab.js). Its label is its name and tooltip. */
export function Fab(props: FabProps): JSX.Element {
  return (
    <button
      type="button"
      id={props.id}
      data-kit="fab"
      data-part={props.part ?? 'ui.fab'}
      data-give-way={flag(props.giveWay)}
      aria-hidden={props.giveWay ? 'true' : undefined}
      tabIndex={props.giveWay ? -1 : 0}
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onClick()}
    >
      <Icon name={props.icon} size="lg" />
    </button>
  );
}
