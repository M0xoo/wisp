// Bubble: what was said to the agent (v1 .ask): an optional by-line, the text (content: it wraps,
// long ones clamp behind Show all), attachments, and a foot of small facts on one line.
import { Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';

export interface BubbleProps extends KitProps {
  /** "Sent by wisp …", "From the crew …": one line above the text */
  readonly by?: JSX.Element;
  /** extra content above the text (the goal's Still missing, comment cards) */
  readonly top?: JSX.Element;
  readonly children?: JSX.Element;
  /** clamp the text to a few lines (Show all lifts it) */
  readonly clamped?: boolean;
  /** the Show all / Show less control, under the text */
  readonly more?: JSX.Element;
  readonly attachments?: JSX.Element;
  /** model, mode, time, checkpoint: control text on one line that never wraps */
  readonly foot?: JSX.Element;
  /** the corner control (collapse this exchange) */
  readonly corner?: JSX.Element;
  /** sent by wisp, not by you: quieter */
  readonly byWisp?: boolean;
  /** a Compact now: one quiet line */
  readonly quiet?: boolean;
}

export function Bubble(props: BubbleProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.bubble';
  return (
    <div id={props.id} data-kit="bubble" data-part={part()} data-by-wisp={flag(props.byWisp)} data-quiet={flag(props.quiet)}>
      <Show when={props.by}>
        <div data-kit="bubble-by" data-part={sub(part(), 'by')} data-text="control">
          {props.by}
        </div>
      </Show>
      {props.top}
      <Show when={props.children}>
        <div data-kit="bubble-text" data-part={sub(part(), 'text')} data-clamped={flag(props.clamped)}>
          {props.children}
        </div>
      </Show>
      {props.more}
      <Show when={props.attachments}>
        <div data-kit="bubble-atts" data-part={sub(part(), 'atts')}>
          {props.attachments}
        </div>
      </Show>
      <Show when={props.foot}>
        <div data-kit="bubble-foot" data-part={sub(part(), 'foot')}>
          {props.foot}
        </div>
      </Show>
      <Show when={props.corner}>
        <div data-kit="bubble-corner">{props.corner}</div>
      </Show>
    </div>
  );
}
