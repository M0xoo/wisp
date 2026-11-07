// Spirit: a crew member's avatar (v1 spirit.js), drawn from its code. It breathes and blinks while
// idle, floats and glances around while a job runs, hops while asking, and closes its eyes while
// paused (css/home.css, by `data-state`; reduced motion stills it). Colours are tokens: the body
// glows in its member's colour (--pc-*), the face in --spirit-*.
import { Match, Show, Switch, createUniqueId, type JSX } from 'solid-js';
import type { KitProps } from '../core/props.ts';
import { BEHIND, BODY, TOP, blinkDelay, parseSpirit, type SpiritParts } from './spirit-shape.ts';

export type SpiritState = 'idle' | 'live' | 'asks' | 'sleep';

export interface SpiritProps extends KitProps {
  /** `shape.color.eyes.mouth.extra`; anything else rolls one from `seed` */
  readonly code?: string;
  readonly seed?: string;
  readonly state?: SpiritState;
  /** a dot-sized spirit (a row's): no mouth, no extra */
  readonly small?: boolean;
  /** names it for readers; without one it is decoration beside a name */
  readonly label?: string;
}

const INK = { fill: 'var(--spirit-eye)' };
const STROKE = { fill: 'none', stroke: 'var(--spirit-eye)', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;
const TRIM = { fill: 'none', stroke: 'var(--spirit-trim)', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

function Eyes(p: { readonly kind: SpiritParts['eyes']; readonly sleep: boolean }): JSX.Element {
  return (
    <Switch fallback={<g data-kit="spirit-pupil"><circle cx="25" cy="35" r="3.1" style={INK} /><circle cx="39" cy="35" r="3.1" style={INK} /></g>}>
      <Match when={p.sleep}><path d="M21.5 35q3.5 3.2 7 0M35.5 35q3.5 3.2 7 0" style={STROKE} /></Match>
      <Match when={p.kind === 'happy'}><path d="M21.5 36.5q3.5-4.5 7 0M35.5 36.5q3.5-4.5 7 0" style={STROKE} /></Match>
      <Match when={p.kind === 'wide'}>
        <circle cx="25" cy="34.5" r="4.6" style={{ fill: 'var(--spirit-shine)' }} />
        <circle cx="39" cy="34.5" r="4.6" style={{ fill: 'var(--spirit-shine)' }} />
        <g data-kit="spirit-pupil"><circle cx="25.6" cy="35" r="2.3" style={INK} /><circle cx="39.6" cy="35" r="2.3" style={INK} /></g>
      </Match>
      <Match when={p.kind === 'sleepy'}>
        <path d="M21.5 34.5h7M35.5 34.5h7" style={STROKE} />
        <path d="M22.5 35.5q2.5 2.4 5 0M36.5 35.5q2.5 2.4 5 0" style={{ ...STROKE, 'stroke-width': '1.8' }} />
      </Match>
      <Match when={p.kind === 'visor'}>
        <rect x="17.5" y="30.5" width="29" height="9" rx="4.5" style={INK} />
        <rect data-kit="spirit-scan" x="20" y="33.6" width="7" height="2.8" rx="1.4" style={{ fill: 'var(--k-sp-a)' }} />
      </Match>
      <Match when={p.kind === 'wink'}>
        <circle cx="25" cy="35" r="3.1" style={INK} />
        <path d="M35.5 36q3.5-4 7 0" style={STROKE} />
      </Match>
      <Match when={p.kind === 'spark'}>
        <path d="M25 30.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3zM39 30.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z" style={INK} />
      </Match>
    </Switch>
  );
}

function Mouth(p: { readonly kind: SpiritParts['mouth'] }): JSX.Element {
  return (
    <Switch fallback={<path d="M28 43q4 4 8 0" style={STROKE} />}>
      <Match when={p.kind === 'grin'}><path d="M27 42.5h10q-.8 5.5-5 5.5t-5-5.5z" style={INK} /></Match>
      <Match when={p.kind === 'o'}><circle cx="32" cy="44.5" r="2.3" style={INK} /></Match>
      <Match when={p.kind === 'flat'}><path d="M29 44.5h6" style={STROKE} /></Match>
      <Match when={p.kind === 'cat'}><path d="M27 43q2.5 3 5 0 2.5 3 5 0" style={{ ...STROKE, 'stroke-width': '2' }} /></Match>
      <Match when={p.kind === 'none'}>{null}</Match>
    </Switch>
  );
}

function Extra(p: { readonly kind: SpiritParts['extra']; readonly top: number }): JSX.Element {
  const t = (): number => p.top;
  const gold = { fill: 'var(--spirit-gold)', stroke: 'var(--spirit-trim)', 'stroke-width': '1.2', 'stroke-linejoin': 'round' } as const;
  return (
    <Switch>
      <Match when={p.kind === 'halo'}><ellipse data-kit="spirit-halo" cx="32" cy={t() - 4} rx="10.5" ry="3.2" style={{ fill: 'none', stroke: 'var(--spirit-gold)', 'stroke-width': '2.4' }} /></Match>
      <Match when={p.kind === 'antenna'}>
        <path d={`M32 ${t() + 1}V${t() - 7}`} style={TRIM} />
        <circle data-kit="spirit-beacon" cx="32" cy={t() - 9} r="3" style={{ fill: 'var(--k-sp-a)', stroke: 'var(--spirit-trim)', 'stroke-width': '1.6' }} />
      </Match>
      <Match when={p.kind === 'crown'}><path d={`M22.5 ${t() + 3}l2-9.5 4.5 5.5 3-8 3 8 4.5-5.5 2 9.5z`} style={gold} /></Match>
      <Match when={p.kind === 'headphones'}>
        <path d={`M14.5 36C14.5 ${t() - 5} 49.5 ${t() - 5} 49.5 36`} style={{ fill: 'none', stroke: 'var(--spirit-trim)', 'stroke-width': '3', 'stroke-linecap': 'round' }} />
        <rect x="10" y="30" width="8" height="12" rx="3.5" style={{ fill: 'var(--spirit-trim)' }} />
        <rect x="46" y="30" width="8" height="12" rx="3.5" style={{ fill: 'var(--spirit-trim)' }} />
      </Match>
      <Match when={p.kind === 'leaf'}>
        <path d={`M32 ${t() + 2}q0-5 2-8`} style={TRIM} />
        <path d={`M34 ${t() - 6}c3-6 10-6 12-4-2 5-8 7-12 4z`} style={{ fill: 'var(--spirit-leaf)', stroke: 'var(--spirit-trim)', 'stroke-width': '1.2' }} />
      </Match>
      <Match when={p.kind === 'horns'}>
        <path d={`M22 ${t() + 6}c-5-3-6-9-3-13 1 4 3 6 7 8zM42 ${t() + 6}c5-3 6-9 3-13-1 4-3 6-7 8z`} style={{ fill: 'var(--k-sp-b)', stroke: 'var(--spirit-trim)', 'stroke-width': '1.3', 'stroke-linejoin': 'round' }} />
      </Match>
      <Match when={p.kind === 'beanie'}>
        <path d={`M16 ${t() + 11}c0-11 7-15 16-15s16 4 16 15z`} style={{ fill: 'var(--spirit-trim)' }} />
        <path d={`M15 ${t() + 11}h34`} style={{ stroke: 'var(--spirit-trim)', 'stroke-width': '4', 'stroke-linecap': 'round' }} />
        <circle cx="32" cy={t() - 5} r="3.6" style={{ fill: 'var(--spirit-shine)', stroke: 'var(--spirit-trim)', 'stroke-width': '1.2' }} />
      </Match>
      <Match when={p.kind === 'bolt'}><path data-kit="spirit-bolt" d={`M47 ${t() - 6}l-6 9h4.5l-2.5 7 7-10h-4.5z`} style={{ ...gold, 'stroke-width': '1.1' }} /></Match>
    </Switch>
  );
}

export function Spirit(props: SpiritProps): JSX.Element {
  const p = (): SpiritParts => parseSpirit(props.code, props.seed ?? '');
  const grad = createUniqueId();
  const top = (): number => TOP[p().shape];
  const behind = (): boolean => !props.small && BEHIND.has(p().extra);
  return (
    <svg
      id={props.id}
      viewBox="0 0 64 64"
      data-kit="spirit"
      data-part={props.part ?? 'ui.spirit'}
      data-state={props.state ?? 'idle'}
      data-color={p().color}
      style={{ '--k-blink': `${blinkDelay(props.code ?? props.seed ?? '')}s` }}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <defs>
        <radialGradient id={grad} cx="38%" cy="32%" r="72%">
          <stop offset="0" style={{ 'stop-color': 'var(--k-sp-a)' }} />
          <stop offset="1" style={{ 'stop-color': 'var(--k-sp-b)' }} />
        </radialGradient>
      </defs>
      <g data-kit="spirit-float">
        <Show when={behind()}>
          <Extra kind={p().extra} top={top()} />
        </Show>
        <path d={BODY[p().shape]} style={{ fill: `url(#${grad})` }} />
        <ellipse cx="24" cy="24" rx="5" ry="3" transform="rotate(-30 24 24)" style={{ fill: 'var(--spirit-shine)', opacity: '0.45' }} />
        <ellipse cx="20" cy="41" rx="3" ry="1.8" style={{ fill: 'var(--spirit-blush)', opacity: '0.55' }} />
        <ellipse cx="44" cy="41" rx="3" ry="1.8" style={{ fill: 'var(--spirit-blush)', opacity: '0.55' }} />
        <g data-kit="spirit-eyes">
          <Eyes kind={p().eyes} sleep={props.state === 'sleep'} />
        </g>
        <Show when={!props.small}>
          <Mouth kind={p().mouth} />
        </Show>
        <Show when={!props.small && !behind()}>
          <Extra kind={p().extra} top={top()} />
        </Show>
      </g>
    </svg>
  );
}
