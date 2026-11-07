// Stats: a grid of numbers (v1's .b-stats): the value large and tabular, its unit, a label, and a
// delta coloured only when it means good or bad.
import { For, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';

export interface Stat {
  readonly label: string;
  readonly value: string | number;
  readonly unit?: string;
  /** The change, already worded: "+6", "−12%". */
  readonly delta?: string;
  readonly tone?: 'good' | 'bad' | 'neutral';
}

export interface StatsProps extends KitProps {
  readonly items: readonly Stat[];
  /** Formats numbers; default: the reader's locale. */
  readonly format?: (value: number) => string;
}

export function Stats(props: StatsProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.stats';
  const shown = (v: string | number): string => (typeof v === 'number' ? (props.format ?? ((n) => n.toLocaleString()))(v) : v);
  return (
    <dl id={props.id} data-kit="stats" data-part={part()}>
      <For each={props.items}>
        {(s) => (
          <div data-kit="stat" data-part={sub(part(), 'item')} data-tone={s.tone}>
            <dt data-kit="stat-label" data-text="control">{s.label}</dt>
            <dd data-kit="stat-value">
              {shown(s.value)}
              <Show when={s.unit}>{(u) => <span data-kit="stat-unit">{u()}</span>}</Show>
            </dd>
            <Show when={s.delta}>{(d) => <dd data-kit="stat-delta">{d()}</dd>}</Show>
          </div>
        )}
      </For>
    </dl>
  );
}
