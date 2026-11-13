// A task's topic is a window (v1 #788, plugins/runtime/core/src/turn_window.rs): its latest 8 turns come whole,
// older ones as stubs (`body.stub`) with what their folded row and the usage card read. Opening a stub asks for
// that one turn (`session:<id>/turn/<turn id>`: its row and its events), never the whole task again.

import { createEffect, createSignal } from 'solid-js';
import type { Scope } from '@wisp/client';
import type { Topic } from '@wisp/protocol';

/** Whether a turn's body is the window's stub of it. */
export const isStub = (body: unknown): boolean => (body as { readonly stub?: unknown } | undefined)?.stub === true;

/** One turn whole, with its events. */
export const turnTopic = (bare: string, turnId: string): Topic => `session:${bare}/turn/${turnId}`;

/** Every turn row whole, no events (the Changes pane and Compare list every edit). */
export const turnsTopic = (bare: string): Topic => `session:${bare}/turns`;

export interface TurnOpener {
  /** asks for the stubbed turn whole */
  open(turnId: string): void;
  /** asked for, and still a stub: its control shows pending */
  opening(turnId: string): boolean;
}

/**
 * Opens stubbed turns one at a time. Each watch lives in its own child of `scope` (the view's), so closing the
 * task drops them. When the task's topic sends an opened turn as a stub again (a resync), it asks again.
 */
/** How long an opened turn may stay a stub before its control gives up (a peer without the window answers empty). */
export const OPEN_TIMEOUT_MS = 15_000;

export function turnOpener(o: {
  readonly scope: Scope;
  readonly bare: string;
  watch(topic: Topic, scope: Scope): void;
  stubOf(turnId: string): boolean | undefined;
  /** it never came: the control is pressable again */
  failed?(turnId: string): void;
}): TurnOpener {
  const [wanted, setWanted] = createSignal<ReadonlySet<string>>(new Set());
  const watches = new Map<string, { scope: Scope; landed: boolean }>();
  createEffect(() => {
    for (const id of wanted()) {
      const stub = o.stubOf(id);
      const w = watches.get(id);
      if (stub === undefined || (stub && w && !w.landed)) continue; // gone, or asked and on its way
      if (!stub) {
        if (w) w.landed = true;
        continue;
      }
      w?.scope.dispose(); // unsubscribing first: the next subscribe gets a fresh snapshot
      const s = o.scope.child(`turn:${id}`);
      o.watch(turnTopic(o.bare, id), s);
      const w2 = { scope: s, landed: false };
      watches.set(id, w2);
      s.timeout(OPEN_TIMEOUT_MS, () => {
        if (w2.landed || watches.get(id) !== w2) return;
        watches.delete(id);
        s.dispose();
        const next = new Set(wanted());
        next.delete(id);
        setWanted(next);
        o.failed?.(id);
      });
    }
  });
  return {
    open: (id) => {
      if (!wanted().has(id)) setWanted(new Set([...wanted(), id]));
    },
    opening: (id) => wanted().has(id) && o.stubOf(id) === true,
  };
}

/**
 * Keeps every turn of a task whole while `scope` lives (`session:<id>/turns`). A resync of the task's own topic
 * sends its older turns as stubs over the whole rows; once they had landed, it asks again.
 */
export function keepTurnsWhole(o: { readonly scope: Scope; readonly bare: string; watch(topic: Topic, scope: Scope): void; stubbed(): boolean }): void {
  let w = o.scope.child('turns');
  o.watch(turnsTopic(o.bare), w);
  let landed = false;
  createEffect(() => {
    const stub = o.stubbed();
    if (!stub) landed = true;
    else if (landed) {
      landed = false;
      w.dispose();
      w = o.scope.child('turns');
      o.watch(turnsTopic(o.bare), w);
    }
  });
}
