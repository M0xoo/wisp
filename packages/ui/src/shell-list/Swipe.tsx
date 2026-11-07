// Swipe: a touch row that runs an action when pulled sideways (v1 web/js/features/swipe.js). The band
// under the row says the action in the menus' words, warms with the pull and fills once letting go
// would run it. A side with no action only gives a little. Letting go past the line flies the row off
// its edge, closes its height, then calls onSwipe; anything short springs back. Touch only: a mouse
// or pen drag is a text selection. No timers: each step waits for its own transition to end.
import { createSignal, Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { swipeArmed, swipeCommits, swipeOffset, swipePhase, swipeSpeed, swipeStarts } from './swipe-math.ts';

export type SwipeDir = 'left' | 'right';

export interface SwipeSide {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: 'good' | 'accent' | 'neutral' | 'bad';
}

export interface SwipeProps extends KitProps, WithChildren {
  /** what pulling the row to the left does; none: it only gives a little */
  readonly left?: SwipeSide | undefined;
  readonly right?: SwipeSide | undefined;
  readonly onSwipe: (dir: SwipeDir) => void;
  readonly disabled?: boolean;
  /** the pull crossed the line (true) or came back (false): a haptic tick */
  readonly onArm?: (armed: boolean) => void;
}

type Phase = 'idle' | 'drag' | 'gone' | 'closing';
/** controls inside the row keep their own touches */
const OWN = "[data-kit='button'], [data-kit='icon-button'], input, textarea, select, [contenteditable='true'], [data-swipe='none']";

interface Track {
  x: number;
  y: number;
  width: number;
  mode: 'pending' | 'swipe' | 'scroll';
  samples: { x: number; t: number }[];
}

export function Swipe(props: SwipeProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.swipe';
  const [phase, setPhase] = createSignal<Phase>('idle');
  const [dx, setDx] = createSignal(0);
  const [armed, setArmed] = createSignal(false);
  const [height, setHeight] = createSignal<number | undefined>(undefined);
  const st: { track: Track | undefined; swallow: boolean; dir: SwipeDir; el: HTMLDivElement | undefined } = { track: undefined, swallow: false, dir: 'right', el: undefined };
  const side = (d: number): SwipeSide | undefined => (d > 0 ? props.right : d < 0 ? props.left : undefined);

  const reset = (): void => {
    st.track = undefined;
    setPhase('idle');
    setDx(0);
    setArmed(false);
    setHeight(undefined);
  };
  const down = (e: PointerEvent): void => {
    st.swallow = false;
    if (props.disabled || e.pointerType !== 'touch' || !e.isPrimary || phase() !== 'idle') return;
    if (e.target instanceof Element && e.target.closest(OWN)) return;
    if (!swipeStarts(e.clientX, window.innerWidth)) return;
    st.track = { x: e.clientX, y: e.clientY, width: st.el?.getBoundingClientRect().width ?? 0, mode: 'pending', samples: [{ x: e.clientX, t: e.timeStamp }] };
  };
  const move = (e: PointerEvent): void => {
    const tr = st.track;
    if (!tr || tr.mode === 'scroll') return;
    const ddx = e.clientX - tr.x;
    if (tr.mode === 'pending') {
      tr.mode = swipePhase(ddx, e.clientY - tr.y);
      if (tr.mode !== 'swipe') return;
      st.el?.setPointerCapture(e.pointerId);
      setPhase('drag');
    }
    tr.samples.push({ x: e.clientX, t: e.timeStamp });
    if (tr.samples.length > 12) tr.samples.shift();
    const can = side(ddx) !== undefined;
    setDx(swipeOffset(ddx, can));
    const now = swipeArmed(ddx, tr.width, can);
    if (now !== armed()) {
      setArmed(now);
      props.onArm?.(now);
    }
  };
  const up = (e: PointerEvent): void => {
    const tr = st.track;
    st.track = undefined;
    if (!tr || tr.mode !== 'swipe') return;
    st.swallow = true;
    const ddx = e.clientX - tr.x;
    if (!swipeCommits(ddx, tr.width, side(ddx) !== undefined, swipeSpeed(tr.samples))) return reset();
    st.dir = ddx > 0 ? 'right' : 'left';
    setArmed(true);
    setPhase('gone');
    setDx(Math.sign(ddx) * (tr.width + 24));
  };
  // the row has flown off: close its height, then run the action
  const ended = (e: TransitionEvent): void => {
    if (e.target !== e.currentTarget) return;
    if (phase() === 'gone' && e.propertyName === 'transform') {
      setHeight(st.el?.getBoundingClientRect().height ?? 0);
      requestAnimationFrame(() => {
        setPhase('closing');
        setHeight(0);
      });
    } else if (phase() === 'closing' && e.propertyName === 'height') {
      const dir = st.dir;
      reset();
      props.onSwipe(dir);
    }
  };
  const click = (e: MouseEvent): void => {
    if (!st.swallow) return;
    st.swallow = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const band = (): SwipeSide | undefined => side(dx());

  return (
    <div
      ref={(el) => (st.el = el)}
      id={props.id}
      data-kit="swipe"
      data-part={part()}
      data-phase={phase()}
      data-armed={flag(armed())}
      data-dir={dx() > 0 ? 'right' : dx() < 0 ? 'left' : undefined}
      style={{ '--k-sw-x': `${dx()}px`, '--k-sw-h': height() === undefined ? undefined : `${height()}px` }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={reset}
      onContextMenu={() => phase() === 'drag' && reset()}
      onClickCapture={click}
      onTransitionEnd={ended}
    >
      <Show when={band()}>
        {(b) => (
          <div data-kit="swipe-band" data-part={sub(part(), 'band')} data-tone={b().tone} aria-hidden="true">
            <Icon name={armed() ? 'check' : b().icon} size="md" />
            <span data-kit="swipe-label" data-text="control">{b().label}</span>
          </div>
        )}
      </Show>
      <div data-kit="swipe-row" data-part={sub(part(), 'row')} onTransitionEnd={ended}>
        {props.children}
      </div>
    </div>
  );
}
