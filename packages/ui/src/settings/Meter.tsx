// Meter: how much of something is used (a plan's usage window, a disk), with an optional line
// where something happens (Automations stop at 80%). The value is a share, 0..1.
import { Show, type JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { styleOf, sub, type KitProps, type PartName } from '../core/props.ts';

export interface MeterProps extends KitProps {
  /** 0..1; clamped. */
  readonly value: number;
  /** The accessible name: "5-hour window". */
  readonly label: string;
  /** Read out instead of the percent: "42% used, resets 21:00". */
  readonly valueText?: string;
  /** A line across the bar, 0..1: where a limit or a stop line sits. */
  readonly mark?: number;
  readonly markLabel?: string;
  readonly tone?: Tone;
}

const clamp = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const pct = (v: number): string => `${Math.round(clamp(v) * 1000) / 10}%`;

export function Meter(props: MeterProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.meter';
  return (
    <div
      id={props.id}
      data-kit="meter"
      data-part={part()}
      data-tone={props.tone ?? 'accent'}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp(props.value) * 100)}
      aria-valuetext={props.valueText}
      style={styleOf({ '--k-v': pct(props.value) })}
    >
      <span data-kit="meter-fill" data-part={sub(part(), 'fill')} />
      <Show when={props.mark}>
        {(m) => <span data-kit="meter-mark" data-part={sub(part(), 'mark')} title={props.markLabel} style={styleOf({ '--k-m': pct(m()) })} />}
      </Show>
    </div>
  );
}
