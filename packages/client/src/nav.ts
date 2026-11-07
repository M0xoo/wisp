// Navigation, kind 3 (plan §4.6.4): one state for what's open, one pure reducer that writes it.
// Intents name what the user did; the reducer decides what that means, so the rules v1 learned
// one bug at a time live here, with tests:
//   #573 #574  Open on a toast closes the viewer or dialog over the page
//   #354       Mark done / Archive / Delete on the open task goes Home, not to the next task
//   #406       renaming a task keeps it open
//   back       pops the top overlay, then the side pane, then main (to Home)
// What's open is never stored on entities.

import { assertNever, type CrewId, type ExtensionId, type Json, type SessionId } from './types.ts';

export type Layout = 'split' | 'stack';
export type Main =
  | { kind: 'home' }
  | { kind: 'task'; id: SessionId }
  | { kind: 'crew'; id: CrewId }
  | { kind: 'view'; id: ExtensionId; params: Json };
export type Side = { kind: 'none' } | { kind: 'changes' | 'shell' | 'pr'; id: SessionId } | { kind: 'view'; id: ExtensionId };
export type Overlay = { kind: 'viewer' | 'dialog' | 'sheet'; id: ExtensionId; params: Json };

export type Nav = {
  layout: Layout; // from width, never set by features
  main: Main;
  side: Side;
  overlays: readonly Overlay[]; // a stack: the last one is on top and active
};

/** Where an Open on a toast or a notification goes. */
export type Target = { to: 'main'; main: Main } | { to: 'side'; main: Main; side: Side } | { to: 'overlay'; overlay: Overlay };

export type Intent =
  | { t: 'openTask'; id: SessionId }
  | { t: 'openCrew'; id: CrewId }
  | { t: 'openView'; id: ExtensionId; params: Json }
  | { t: 'home' }
  | { t: 'openSide'; side: Exclude<Side, { kind: 'none' }> }
  | { t: 'toggleSide'; side: Exclude<Side, { kind: 'none' }> }
  | { t: 'closeSide' }
  | { t: 'openOverlay'; overlay: Overlay }
  /** closes the top overlay, or the one named and everything above it */
  | { t: 'closeOverlay'; id?: ExtensionId }
  | { t: 'back' }
  | { t: 'markDone'; id: SessionId }
  | { t: 'archive'; id: SessionId }
  | { t: 'delete'; id: SessionId }
  | { t: 'rename'; id: SessionId }
  | { t: 'openFromToast'; target: Target }
  | { t: 'resize'; width: number }
  /** the URL changed under us (Back button, a shared link, a notification) */
  | { t: 'restore'; to: Omit<Nav, 'layout'> };

/** v1's split breakpoint (web/js/spell-schema.js SPLIT_MIN_WIDTH). */
export const SPLIT_MIN_WIDTH = 900;

export const HOME: Main = { kind: 'home' };
export const NO_SIDE: Side = { kind: 'none' };

export function layoutFor(width: number): Layout {
  return width >= SPLIT_MIN_WIDTH ? 'split' : 'stack';
}

export function initialNav(width: number): Nav {
  return { layout: layoutFor(width), main: HOME, side: NO_SIDE, overlays: [] };
}

const sideTask = (s: Side): SessionId | undefined => (s.kind === 'changes' || s.kind === 'shell' || s.kind === 'pr' ? s.id : undefined);
const mainTask = (m: Main): SessionId | undefined => (m.kind === 'task' ? m.id : undefined);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function sameNav(a: Nav, b: Nav): boolean {
  return same(a, b);
}

/**
 * A new main is a new context. Overlays over the old one close, and a side pane bound to another
 * task closes too: the shell of task A must never sit beside task B.
 */
function toMain(nav: Nav, main: Main): Nav {
  if (same(nav.main, main) && nav.overlays.length === 0) return nav;
  const st = sideTask(nav.side);
  const side = st !== undefined && st !== mainTask(main) ? NO_SIDE : nav.side;
  return { ...nav, main, side, overlays: [] };
}

function toSide(nav: Nav, side: Side): Nav {
  const st = sideTask(side);
  // a task's pane opens beside that task: from anywhere else it brings the task along
  const main: Main = st !== undefined && mainTask(nav.main) !== st ? { kind: 'task', id: st } : nav.main;
  const next = { ...nav, main, side };
  return same(next, nav) ? nav : next;
}

function closeOverlay(nav: Nav, id: ExtensionId | undefined): Nav {
  if (nav.overlays.length === 0) return nav;
  if (id === undefined) return { ...nav, overlays: nav.overlays.slice(0, -1) };
  const i = nav.overlays.findIndex((o) => o.id === id);
  return i < 0 ? nav : { ...nav, overlays: nav.overlays.slice(0, i) };
}

/** The task leaves its list (done, archived, deleted): if it was open, Home (#354). */
function leaveTask(nav: Nav, id: SessionId): Nav {
  const openMain = mainTask(nav.main) === id;
  const openSide = sideTask(nav.side) === id;
  if (!openMain && !openSide) return nav;
  return { ...nav, main: openMain ? HOME : nav.main, side: NO_SIDE, overlays: openMain ? [] : nav.overlays };
}

function back(nav: Nav): Nav {
  if (nav.overlays.length > 0) return { ...nav, overlays: nav.overlays.slice(0, -1) };
  if (nav.side.kind !== 'none') return { ...nav, side: NO_SIDE };
  if (nav.main.kind !== 'home') return { ...nav, main: HOME };
  return nav;
}

/** Open on a toast: the target comes into view, so nothing may stay over it (#573, #574). */
function fromToast(nav: Nav, target: Target): Nav {
  const bare: Nav = { ...nav, overlays: [] };
  let next: Nav;
  switch (target.to) {
    case 'main':
      next = toMain(bare, target.main);
      break;
    case 'side':
      next = toSide(toMain(bare, target.main), target.side);
      break;
    case 'overlay':
      next = { ...bare, overlays: [target.overlay] };
      break;
    default:
      return assertNever(target, 'toast target');
  }
  return same(next, nav) ? nav : next;
}

/** The one writer of navigation state. Pure; returns `nav` itself when nothing changes. */
export function navigate(nav: Nav, intent: Intent): Nav {
  switch (intent.t) {
    case 'openTask':
      return toMain(nav, { kind: 'task', id: intent.id });
    case 'openCrew':
      return toMain(nav, { kind: 'crew', id: intent.id });
    case 'openView':
      return toMain(nav, { kind: 'view', id: intent.id, params: intent.params });
    case 'home':
      return toMain(nav, HOME);
    case 'openSide':
      return toSide(nav, intent.side);
    case 'toggleSide':
      return same(nav.side, intent.side) ? { ...nav, side: NO_SIDE } : toSide(nav, intent.side);
    case 'closeSide':
      return nav.side.kind === 'none' ? nav : { ...nav, side: NO_SIDE };
    case 'openOverlay': {
      const top = nav.overlays.at(-1);
      if (top && same(top, intent.overlay)) return nav; // a double click opens one
      return { ...nav, overlays: [...nav.overlays.filter((o) => o.id !== intent.overlay.id), intent.overlay] };
    }
    case 'closeOverlay':
      return closeOverlay(nav, intent.id);
    case 'back':
      return back(nav);
    case 'markDone':
    case 'archive':
    case 'delete':
      return leaveTask(nav, intent.id);
    case 'rename':
      return nav; // #406: editing the title is not a navigation
    case 'openFromToast':
      return fromToast(nav, intent.target);
    case 'resize': {
      const layout = layoutFor(intent.width);
      return layout === nav.layout ? nav : { ...nav, layout };
    }
    case 'restore': {
      const next = { layout: nav.layout, main: intent.to.main, side: intent.to.side, overlays: intent.to.overlays };
      return same(next, nav) ? nav : next;
    }
    default:
      return assertNever(intent, 'navigation intent');
  }
}

/** Intents that make a history entry (Back undoes them); the rest replace the current one. */
export function pushes(intent: Intent): boolean {
  switch (intent.t) {
    case 'openTask':
    case 'openCrew':
    case 'openView':
    case 'home':
    case 'openSide':
    case 'toggleSide':
    case 'openOverlay':
    case 'openFromToast':
      return true;
    case 'closeSide':
    case 'closeOverlay':
    case 'back':
    case 'markDone':
    case 'archive':
    case 'delete':
    case 'rename':
    case 'resize':
    case 'restore':
      return false;
    default:
      return assertNever(intent, 'navigation intent');
  }
}
