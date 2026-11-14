// A spirit as SVG (v1 web/js/spirit.js spiritSvg, drawn the same). How it moves lives in
// css/crew.css, keyed on data-mood: idle breathes and blinks, live floats and glances, asks hops,
// sleep closes its eyes. Its glow is its colour's gradient, made per spirit (a unique id).
import { createUniqueId, Match, Show, Switch, type JSX } from 'solid-js';
import { parseSpirit, spiritHash, type SpiritMood, type SpiritParts } from './spirit-code.ts';

/** Where each body's head starts (its top), so extras sit on it. */
const TOP: Readonly<Record<SpiritParts['shape'], number>> = { flame: 6, blob: 12, ghost: 13, drop: 8, star: 10, bean: 12 };

function starPath(cx: number, cy: number, r1: number, r2: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 ? r2 : r1;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

const BODY: Readonly<Record<SpiritParts['shape'], string>> = {
  flame: 'M31 4c2.5 8.5 9.5 11.5 13.5 18 1.8-2.8 2.2-6 1.6-9.5C52 18 55 25.5 55 33.5 55 47 44.5 57 32 57S9 47 9 33.5c0-7 3-12.5 7.5-16.5-.2 4.2.9 7.3 3 9.6C20.7 17 25 10 31 4z',
  blob: 'M32 12c13.5 0 21.5 9 21.5 22.5S44.5 57 32 57 10.5 48 10.5 34.5 18.5 12 32 12z',
  ghost: 'M13.5 34C13.5 21 22 13 32 13s18.5 8 18.5 21v22l-4.6-4-4.6 4-4.6-4-4.7 4-4.6-4-4.6 4-4.6-4-4.7 4z',
  drop: 'M32 8c8.5 12.5 19.5 22 19.5 33.5a19.5 19.5 0 0 1-39 0C12.5 30 23.5 20.5 32 8z',
  star: starPath(32, 36, 25, 14),
  bean: 'M21 14.5c9.5-4.5 23 0 27 10.5 5 12.5-1 28-14.5 31.5C21 59.5 11 51 11 38.5c0-10.5 2-20 10-24z',
};

const INK = { fill: 'var(--spirit-eye)' } as const;
const STROKE = { fill: 'none', stroke: 'var(--spirit-eye)', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;
// Trims stick out past the body, onto the page: their own colour, so they show in dark mode too.
const TRIM = { fill: 'none', stroke: 'var(--spirit-trim)', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

function Eyes(props: { readonly kind: SpiritParts['eyes']; readonly sleep: boolean }): JSX.Element {
  return (
    <Switch fallback={<g data-kit="spirit-pupil"><circle cx="25" cy="35" r="3.1" {...INK} /><circle cx="39" cy="35" r="3.1" {...INK} /></g>}>
      <Match when={props.sleep}><path d="M21.5 35q3.5 3.2 7 0M35.5 35q3.5 3.2 7 0" {...STROKE} /></Match>
      <Match when={props.kind === 'happy'}><path d="M21.5 36.5q3.5-4.5 7 0M35.5 36.5q3.5-4.5 7 0" {...STROKE} /></Match>
      <Match when={props.kind === 'wide'}>
        <circle cx="25" cy="34.5" r="4.6" fill="var(--spirit-shine)" /><circle cx="39" cy="34.5" r="4.6" fill="var(--spirit-shine)" />
        <g data-kit="spirit-pupil"><circle cx="25.6" cy="35" r="2.3" {...INK} /><circle cx="39.6" cy="35" r="2.3" {...INK} /></g>
      </Match>
      <Match when={props.kind === 'sleepy'}><path d="M21.5 34.5h7M35.5 34.5h7" {...STROKE} /><path d="M22.5 35.5q2.5 2.4 5 0M36.5 35.5q2.5 2.4 5 0" {...STROKE} stroke-width="1.8" /></Match>
      <Match when={props.kind === 'visor'}><rect x="17.5" y="30.5" width="29" height="9" rx="4.5" {...INK} /><rect data-kit="spirit-scan" x="20" y="33.6" width="7" height="2.8" rx="1.4" /></Match>
      <Match when={props.kind === 'wink'}><circle cx="25" cy="35" r="3.1" {...INK} /><path d="M35.5 36q3.5-4 7 0" {...STROKE} /></Match>
      <Match when={props.kind === 'spark'}><path d="M25 30.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3zM39 30.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z" {...INK} /></Match>
    </Switch>
  );
}

function Mouth(props: { readonly kind: SpiritParts['mouth'] }): JSX.Element {
  return (
    <Switch fallback={<path d="M28 43q4 4 8 0" {...STROKE} />}>
      <Match when={props.kind === 'none'}>{null}</Match>
      <Match when={props.kind === 'grin'}><path d="M27 42.5h10q-.8 5.5-5 5.5t-5-5.5z" {...INK} /></Match>
      <Match when={props.kind === 'o'}><circle cx="32" cy="44.5" r="2.3" {...INK} /></Match>
      <Match when={props.kind === 'flat'}><path d="M29 44.5h6" {...STROKE} /></Match>
      <Match when={props.kind === 'cat'}><path d="M27 43q2.5 3 5 0 2.5 3 5 0" {...STROKE} stroke-width="2" /></Match>
    </Switch>
  );
}

// size-ok: one Match per extra, each a line or two of path data
function Extra(props: { readonly kind: SpiritParts['extra']; readonly t: number }): JSX.Element {
  const t = (): number => props.t;
  return (
    <Switch>
      <Match when={props.kind === 'halo'}><ellipse data-kit="spirit-halo" cx="32" cy={t() - 4} rx="10.5" ry="3.2" fill="none" stroke="var(--spirit-gold)" stroke-width="2.4" /></Match>
      <Match when={props.kind === 'antenna'}><path d={`M32 ${t() + 1}V${t() - 7}`} {...TRIM} /><circle data-kit="spirit-beacon" cx="32" cy={t() - 9} r="3" stroke="var(--spirit-trim)" stroke-width="1.6" /></Match>
      <Match when={props.kind === 'crown'}><path d={`M22.5 ${t() + 3}l2-9.5 4.5 5.5 3-8 3 8 4.5-5.5 2 9.5z`} fill="var(--spirit-gold)" stroke="var(--spirit-trim)" stroke-width="1.2" stroke-linejoin="round" /></Match>
      <Match when={props.kind === 'headphones'}>
        <path d={`M14.5 36C14.5 ${t() - 5} 49.5 ${t() - 5} 49.5 36`} fill="none" stroke="var(--spirit-trim)" stroke-width="3" stroke-linecap="round" />
        <rect x="10" y="30" width="8" height="12" rx="3.5" fill="var(--spirit-trim)" /><rect x="46" y="30" width="8" height="12" rx="3.5" fill="var(--spirit-trim)" />
      </Match>
      <Match when={props.kind === 'leaf'}><path d={`M32 ${t() + 2}q0-5 2-8`} {...TRIM} /><path d={`M34 ${t() - 6}c3-6 10-6 12-4-2 5-8 7-12 4z`} fill="var(--spirit-leaf)" stroke="var(--spirit-trim)" stroke-width="1.2" /></Match>
      <Match when={props.kind === 'horns'}><path data-kit="spirit-horns" d={`M22 ${t() + 6}c-5-3-6-9-3-13 1 4 3 6 7 8zM42 ${t() + 6}c5-3 6-9 3-13-1 4-3 6-7 8z`} stroke="var(--spirit-trim)" stroke-width="1.3" stroke-linejoin="round" /></Match>
      <Match when={props.kind === 'beanie'}>
        <path d={`M16 ${t() + 11}c0-11 7-15 16-15s16 4 16 15z`} fill="var(--spirit-trim)" /><path d={`M15 ${t() + 11}h34`} stroke="var(--spirit-trim)" stroke-width="4" stroke-linecap="round" />
        <circle cx="32" cy={t() - 5} r="3.6" fill="var(--spirit-shine)" stroke="var(--spirit-trim)" stroke-width="1.2" />
      </Match>
      <Match when={props.kind === 'bolt'}><path data-kit="spirit-bolt" d={`M47 ${t() - 6}l-6 9h4.5l-2.5 7 7-10h-4.5z`} fill="var(--spirit-gold)" stroke="var(--spirit-trim)" stroke-width="1.1" stroke-linejoin="round" /></Match>
    </Switch>
  );
}

/** Extras that grow out of the head go behind the body; the rest sit on it. */
const BEHIND = new Set(['antenna', 'leaf', 'horns']);

export interface SpiritProps {
  /** a spirit code; anything else rolls one from `seed` */
  readonly code: string;
  readonly seed?: string;
  readonly mood?: SpiritMood;
  /** a dot-sized spirit (a card's): no mouth, no extra */
  readonly small?: boolean;
  /** an accessible name; without one it is decoration */
  readonly label?: string;
}

export function Spirit(props: SpiritProps): JSX.Element {
  const p = (): SpiritParts => parseSpirit(props.code, props.seed ?? '');
  const grad = createUniqueId();
  const behind = (): boolean => BEHIND.has(p().extra);
  const blink = (): string => `${(spiritHash(props.code || (props.seed ?? '')) % 50) / 10}s`; // they don't all blink together
  return (
    <svg
      data-kit="spirit"
      data-color={p().color}
      data-shape={p().shape}
      data-mood={props.mood ?? 'idle'}
      viewBox="0 0 64 64"
      style={{ '--k-blink': blink() }}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <defs>
        <radialGradient id={`sp-${grad}`} cx="38%" cy="32%" r="72%">
          <stop data-kit="spirit-stop-a" offset="0" />
          <stop data-kit="spirit-stop-b" offset="1" />
        </radialGradient>
      </defs>
      <g data-kit="spirit-float">
        <Show when={!props.small && behind()}><Extra kind={p().extra} t={TOP[p().shape]} /></Show>
        <path data-kit="spirit-body" d={BODY[p().shape]} fill={`url(#sp-${grad})`} />
        <ellipse cx="24" cy="24" rx="5" ry="3" transform="rotate(-30 24 24)" fill="var(--spirit-shine)" opacity="0.45" />
        <ellipse cx="20" cy="41" rx="3" ry="1.8" fill="var(--spirit-blush)" opacity="0.55" />
        <ellipse cx="44" cy="41" rx="3" ry="1.8" fill="var(--spirit-blush)" opacity="0.55" />
        <g data-kit="spirit-eyes"><Eyes kind={p().eyes} sleep={props.mood === 'sleep'} /></g>
        <Show when={!props.small}><Mouth kind={p().mouth} /></Show>
        <Show when={!props.small && !behind()}><Extra kind={p().extra} t={TOP[p().shape]} /></Show>
      </g>
    </svg>
  );
}
