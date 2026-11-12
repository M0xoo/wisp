// ThinkingSlider (v1 runner-picker.js .pk-think): Default on the left, then the harness's thinking levels. The fill is
// a quiet accent tint the knob reveals, the knob is the logo's orb, and wisps (motes along the track) show only where
// it's filled, brighter and quicker the harder it thinks. Dragging previews, letting go commits; arrows, Home and
// End step it.
import { For, createSignal, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';

const MOTES = 14;

/** The stop nearest `f` (0…1 along the track) of `n` stops. */
export const stopAt = (f: number, n: number): number => (n <= 1 ? 0 : Math.round(Math.min(1, Math.max(0, f)) * (n - 1)));

/** Where a key moves the knob from `k` of `n` stops, or undefined (not ours). */
export function stepKey(key: string, k: number, n: number): number | undefined {
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(n - 1, k + 1);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, k - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return undefined;
}

export interface ThinkingSliderProps {
  /** '' first (the harness's own setting), then its levels */
  readonly stops: readonly string[];
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly heading: string;
  /** a stop in words: '' is Default */
  readonly label: (v: string) => string;
  /** what a stop does, in a few words */
  readonly hint?: (v: string) => string;
  readonly aria: { readonly label: string; readonly valueText: (v: string) => string };
}

export function ThinkingSlider(props: ThinkingSliderProps): JSX.Element {
  const n = (): number => props.stops.length;
  const committed = (): number => Math.max(0, props.stops.indexOf(props.value));
  // while dragging: where the finger is (0…1); else the committed stop
  const [drag, setDrag] = createSignal<number | undefined>();
  const k = (): number => (drag() === undefined ? committed() : stopAt(drag() ?? 0, n()));
  const f = (): number => drag() ?? (n() > 1 ? committed() / (n() - 1) : 0);
  const shown = (): string => props.stops[k()] ?? '';
  let bar: HTMLSpanElement | undefined;
  const at = (x: number): number => {
    const r = bar?.getBoundingClientRect();
    if (!r) return 0;
    const pad = r.height / 2;
    return Math.min(1, Math.max(0, (x - r.left - pad) / (r.width - pad * 2)));
  };
  return (
    <div data-kit="think" data-part="runner.think" data-dflt={flag(!shown())} data-drag={flag(drag() !== undefined)} style={{ '--f': String(f()), '--heat': String(k() / Math.max(1, n() - 1)) }}>
      <span data-kit="think-head">
        <span data-kit="think-title">{props.heading}</span>
        <b data-kit="think-value">{props.label(shown())}</b>
        <small data-kit="think-hint">{props.hint?.(shown()) ?? ''}</small>
      </span>
      <span
        ref={(el) => (bar = el)}
        data-kit="think-track"
        role="slider"
        tabindex="0"
        aria-label={props.aria.label}
        aria-valuemin={0}
        aria-valuemax={n() - 1}
        aria-valuenow={k()}
        aria-valuetext={props.aria.valueText(shown())}
        onPointerDown={(e) => {
          if (e.button > 0) return;
          e.preventDefault();
          bar?.focus();
          bar?.setPointerCapture(e.pointerId);
          setDrag(at(e.clientX));
        }}
        onPointerMove={(e) => drag() !== undefined && setDrag(at(e.clientX))}
        onPointerUp={() => {
          const d = drag();
          if (d === undefined) return;
          setDrag(undefined);
          const v = props.stops[stopAt(d, n())] ?? '';
          if (v !== props.value) props.onChange(v);
        }}
        onPointerCancel={() => setDrag(undefined)}
        onKeyDown={(e) => {
          const to = stepKey(e.key, committed(), n());
          if (to === undefined) return;
          e.preventDefault();
          const v = props.stops[to] ?? '';
          if (v !== props.value) props.onChange(v);
        }}
      >
        <span data-kit="think-fill">
          <For each={Array.from({ length: MOTES }, (_, i) => i)}>
            {(i) => <i data-kit="think-mote" style={{ '--x': ((i + 0.5) / MOTES).toFixed(3), '--d': `${((i * 7) % 5) * 0.37}s`, '--y': String((i * 5) % 3) }} />}
          </For>
        </span>
        <For each={props.stops}>{(_, i) => <span data-kit="think-stop" data-past={flag(i() <= k())} style={{ '--at': String(n() > 1 ? i() / (n() - 1) : 0) }} />}</For>
        <span data-kit="think-knob" />
      </span>
    </div>
  );
}
