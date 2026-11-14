// Steps (what was done, in order, v1's .b-steps) and Checklist (where something stands, one item
// per stage, ticked or not, v1's .b-check). Skipped and undone items stay in the list.
import { For, Match, Show, Switch, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export type StepStatus = 'done' | 'current' | 'pending' | 'skipped' | 'failed';

export interface Step {
  readonly title: string;
  readonly detail?: string;
  readonly status: StepStatus;
}

export interface StepsProps extends KitProps {
  readonly items: readonly Step[];
}

function StepMark(props: { readonly status: StepStatus }): JSX.Element {
  return (
    <span data-kit="step-mark" aria-hidden="true">
      <Switch>
        <Match when={props.status === 'done'}><Icon name="check" size="sm" /></Match>
        <Match when={props.status === 'failed'}><Icon name="x" size="sm" /></Match>
        <Match when={props.status === 'skipped'}><Icon name="skip" size="sm" /></Match>
        <Match when={props.status === 'current'}><span data-kit="step-live" /></Match>
      </Switch>
    </span>
  );
}

export function Steps(props: StepsProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.steps';
  return (
    <ol id={props.id} data-kit="steps" data-part={part()}>
      <For each={props.items}>
        {(step) => (
          <li data-kit="step" data-part={sub(part(), 'item')} data-status={step.status} aria-current={step.status === 'current' ? 'step' : undefined}>
            <StepMark status={step.status} />
            <div data-kit="step-text">
              <span data-kit="step-title">{step.title}</span>
              <Show when={step.detail}>{(d) => <p data-kit="step-detail">{d()}</p>}</Show>
            </div>
          </li>
        )}
      </For>
    </ol>
  );
}

export interface ChecklistItem {
  readonly text: string;
  readonly done: boolean;
}

export interface ChecklistProps extends KitProps {
  readonly items: readonly ChecklistItem[];
  /** The box's accessible name (*Done*, *Not done*); without it the box is decoration. */
  readonly statusLabel?: (done: boolean) => string;
}

export function Checklist(props: ChecklistProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.checklist';
  return (
    <ul id={props.id} data-kit="checklist" data-part={part()}>
      <For each={props.items}>
        {(item) => (
          <li data-kit="check-item" data-part={sub(part(), 'item')} data-done={item.done ? '' : undefined}>
            <span
              data-kit="check-box"
              role={props.statusLabel ? 'img' : undefined}
              aria-label={props.statusLabel?.(item.done)}
              aria-hidden={props.statusLabel ? undefined : 'true'}
            >
              <Show when={item.done}><Icon name="check" size="sm" /></Show>
            </span>
            <span data-kit="check-text">{item.text}</span>
          </li>
        )}
      </For>
    </ul>
  );
}
