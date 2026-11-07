// TurnFold: an older exchange folded to one line (v1 .turn.folded .t-fold): a button with the
// prompt (truncating), small tags, the result's title and the time in fixed columns. One line,
// always: nothing on it wraps.
import { Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { sub, type KitProps, type PartName } from '../core/props.ts';

export interface TurnFoldProps extends KitProps {
  readonly prompt: string;
  /** a word before the prompt ("wisp") */
  readonly by?: string;
  /** small tags after it (Rolled back, the computer it ran on) */
  readonly tags?: JSX.Element;
  readonly result?: string;
  readonly time?: JSX.Element;
  /** the accessible name: "Show this exchange" */
  readonly label: string;
  readonly onOpen: () => void;
}

export function TurnFold(props: TurnFoldProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.turn-fold';
  return (
    <button type="button" id={props.id} data-kit="turn-fold" data-part={part()} title={props.label} aria-label={`${props.label}: ${props.prompt}`} onClick={() => props.onOpen()}>
      <Icon name="chevron" size="sm" />
      <span data-kit="turn-fold-prompt" data-part={sub(part(), 'prompt')} data-text="control">
        <Show when={props.by}>
          <b data-kit="turn-fold-by">{props.by}</b>{' '}
        </Show>
        {props.prompt}
      </span>
      {props.tags}
      <Show when={props.result}>
        <span data-kit="turn-fold-result" data-part={sub(part(), 'result')} data-text="control">
          {props.result}
        </span>
      </Show>
      <Show when={props.time}>
        <span data-kit="turn-fold-time">{props.time}</span>
      </Show>
    </button>
  );
}
