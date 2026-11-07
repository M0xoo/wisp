// Gauge: one reading with its last hour (This Mac's Memory, CPU and Disk; design/machine-page.md).
// The name, the value large and tabular, a line under it, a sparkline with an optional dashed mark
// (the floor or the ceiling), and a foot. A row of them sits in `Gauges`: three across where there
// is room, stacked one line each (the sparkline beside the value) where there isn't, decided by a
// container query so the same pane works in Settings, on a page and on a phone.
import { Index, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';
import { Skeleton } from '../content/Skeleton.tsx';

/** Points in 0..1 on both axes: x is time across the hour, y the value over the scale. */
export type SparkPoint = readonly [x: number, y: number];

export interface SparklineProps extends KitProps {
  readonly points: readonly SparkPoint[];
  /** a dashed line at this height (0..1): the limit the value is held to */
  readonly mark?: number | null;
}

const W = 120;
const H = 32;
const sx = (x: number): string => (Math.min(1, Math.max(0, x)) * W).toFixed(1);
const sy = (y: number): string => (H - Math.min(1, Math.max(0, y)) * (H - 2) - 1).toFixed(1);

/** The SVG path of a sparkline, in its 120×32 box. */
export function sparkPath(points: readonly SparkPoint[]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x)} ${sy(y)}`).join(' ');
}

export function Sparkline(props: SparklineProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.sparkline';
  return (
    <svg data-kit="sparkline" data-part={part()} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <Show when={props.mark !== undefined && props.mark !== null}>
        <line data-kit="sparkline-mark" x1="0" x2={W} y1={sy(props.mark ?? 0)} y2={sy(props.mark ?? 0)} />
      </Show>
      <Show when={props.points.length > 1}>
        <path data-kit="sparkline-line" d={sparkPath(props.points)} />
      </Show>
    </svg>
  );
}

export interface GaugeProps extends KitProps {
  readonly name: string;
  /** undefined: still reading (a placeholder of the same shape) */
  readonly value: string | undefined;
  readonly sub?: string;
  readonly foot?: string;
  readonly tone?: 'neutral' | 'warn' | 'bad';
  readonly points?: readonly SparkPoint[];
  readonly mark?: number | null;
}

export function Gauge(props: GaugeProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.gauge';
  const loading = (): boolean => props.value === undefined;
  return (
    <div id={props.id} data-kit="gauge" data-part={part()} data-tone={props.tone ?? 'neutral'} aria-busy={loading() ? 'true' : undefined}>
      <span data-kit="gauge-name" data-text="control">
        {props.name}
      </span>
      <Show when={!loading()} fallback={<Skeleton width="1/2" height="icon-lg" />}>
        <b data-kit="gauge-value" data-part={sub(part(), 'value')} data-text="control">
          {props.value}
        </b>
      </Show>
      <small data-kit="gauge-sub" data-text="control" title={props.sub}>
        {loading() ? <Skeleton width="3/4" /> : props.sub}
      </small>
      <Sparkline part={sub(part(), 'spark')} points={props.points ?? []} mark={props.mark ?? null} />
      <small data-kit="gauge-foot" data-text="control" title={props.foot}>
        {loading() ? <Skeleton width="2/3" /> : props.foot}
      </small>
    </div>
  );
}

export interface GaugesProps extends KitProps {
  readonly items: readonly GaugeProps[];
}

/** Three across, or stacked one line each in a narrow box. */
export function Gauges(props: GaugesProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.gauges';
  return (
    <div id={props.id} data-kit="gauges" data-part={part()}>
      {/* by position: a refresh updates the three in place, nothing remounts */}
      <Index each={props.items}>
        {(g) => <Gauge name={g().name} value={g().value} sub={g().sub ?? ''} foot={g().foot ?? ''} tone={g().tone ?? 'neutral'} points={g().points ?? []} mark={g().mark ?? null} part={g().part ?? 'ui.gauge'} />}
      </Index>
    </div>
  );
}
