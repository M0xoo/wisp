// Swiping a row on the phone (v1 web/js/features/swipe.js, design/mobile.md): right is Mark done /
// Reopen, left is Save for later / Unsave; a plugin may pick Archive or Delete task instead. Pure:
// the gesture's decisions from the pointer's track, so the thresholds have tests.

import type { SessionRow } from '../types.ts';
import { busy } from './row.ts';
import { canSaveForLater } from './menu.ts';
import { isForLater } from './sections.ts';

/** a touch starting this close to the screen's edge is Android's Back */
export const EDGE = 24;
/** movement before it is a swipe or a scroll */
export const SLOP = 10;
/** past this share of the row, letting go runs the action */
export const COMMIT = 0.34;
/** a quick flick commits from a shorter pull */
export const FLICK = { speed: 0.5, min: 56, window: 100 } as const;
/** a row the action can't apply to only gives this much, at a fifth of the pull */
export const GIVE = 28;

export type SwipeKind = 'done' | 'later' | 'archive' | 'delete';

export interface SwipeAction {
  readonly kind: SwipeKind;
  /** i18n key: the same words as the menus */
  readonly label: string;
  readonly icon: 'done' | 'replay' | 'bookmark' | 'archive' | 'trash';
  readonly tone: 'good' | 'accent' | 'neutral' | 'bad';
}

/** What a swipe that way does to this task, or undefined: it only gives a little. */
export function actionFor(kind: SwipeKind, s: SessionRow): SwipeAction | undefined {
  switch (kind) {
    case 'done':
      if (busy(s) || s.archived) return undefined;
      return s.state === 'done' ? { kind, label: 'shell-list.menu.reopen', icon: 'replay', tone: 'good' } : { kind, label: 'shell-list.menu.done', icon: 'done', tone: 'good' };
    case 'later':
      if (isForLater(s)) return { kind, label: 'shell-list.menu.unsave', icon: 'bookmark', tone: 'accent' };
      return canSaveForLater(s) ? { kind, label: 'shell-list.menu.save', icon: 'bookmark', tone: 'accent' } : undefined;
    case 'archive':
      if (s.archived) return { kind, label: 'shell-list.menu.unarchive', icon: 'archive', tone: 'neutral' };
      return busy(s) ? undefined : { kind, label: 'shell-list.menu.archive', icon: 'archive', tone: 'neutral' };
    case 'delete':
      return busy(s) ? undefined : { kind, label: 'shell-list.menu.delete', icon: 'trash', tone: 'bad' };
  }
}

/** Where the gesture stands after the pointer moved by (dx, dy) from where it went down. */
export type Phase = 'pending' | 'swipe' | 'scroll';

export function phaseOf(dx: number, dy: number): Phase {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay > SLOP && ay >= ax) return 'scroll';
  if (ax >= SLOP && ax >= 1.5 * ay) return 'swipe';
  return 'pending';
}

/** A touch that may start a swipe: not on the screen's edge (Back). */
export const startsSwipe = (x: number, screenW: number): boolean => x > EDGE && x < screenW - EDGE;

/** How far the row follows the finger: all the way with an action, a little without. */
export const offsetFor = (dx: number, can: boolean): number => (can ? dx : Math.sign(dx) * Math.min(GIVE, Math.abs(dx) * 0.2));

export const armed = (dx: number, width: number, can: boolean): boolean => can && Math.abs(dx) > width * COMMIT;

/** Letting go: commit when armed, or on a flick (fast enough over the last 100 ms, at least 56 px out). */
export function commits(dx: number, width: number, can: boolean, speed: number): boolean {
  if (!can) return false;
  return armed(dx, width, can) || (Math.abs(speed) >= FLICK.speed && Math.abs(dx) >= FLICK.min && Math.sign(speed) === Math.sign(dx));
}
