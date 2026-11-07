// Flows, kind 4 (plan §4.6.3): a small state-machine runtime for feature flows (Zag runs the kit's
// widgets). A machine is a pure definition; `interpret` runs one inside a scope. Each state entry
// gets a child scope of its own: leaving the state aborts what it invoked and clears its `after`
// timers, so a late answer from a state we already left is dropped by construction (#435, #492).
// Disposing the owner scope stops the machine the same way.

import type { Scope } from './scope.ts';
import { signal, untracked, type Readable } from './signals.ts';
import type { Warn } from './types.ts';

export interface StateNode<S extends string, E extends string, C> {
  on?: { readonly [K in E]?: S };
  /** work this state starts; it may resolve with the event that ends it */
  invoke?: (ctx: C, signal: AbortSignal, send: (event: NoInfer<E>, data?: unknown) => void) => Promise<NoInfer<E> | void> | NoInfer<E> | void;
  /** where a rejected invoke goes; without it the error is logged and the state stays */
  onError?: S;
  /** `{ 8000: 'slow' }`: still here after 8 s, go there */
  after?: { readonly [ms: number]: S };
}

export interface MachineDef<S extends string, E extends string, C> {
  readonly id: string;
  readonly initial: S;
  readonly states: { readonly [K in S]: StateNode<S, E, C> };
}

export function machine<S extends string, E extends string = never, C = void>(def: {
  id: string;
  initial: NoInfer<S>;
  states: { readonly [K in S]: StateNode<NoInfer<S>, E, C> };
}): MachineDef<S, E, C> {
  if (!Object.hasOwn(def.states, def.initial)) throw new Error(`machine ${def.id}: no initial state ${def.initial}`);
  return def;
}

export interface Machine<S extends string, E extends string> {
  readonly id: string;
  readonly state: Readable<S>;
  /** true when the event moved the machine; an event the state doesn't take is ignored */
  send(event: E, data?: unknown): boolean;
  /** the data of the event that entered the current state */
  readonly data: unknown;
  readonly alive: boolean;
  stop(): void;
}

export interface MachineHooks {
  warn?: Warn;
  /** devtools: every transition, with what caused it */
  onTransition?: (machine: string, from: string, via: string, to: string) => void;
}

/** Runs `def` with `ctx` inside a child of `owner`; the machine ends with its owner. */
// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function interpret<S extends string, E extends string, C>(def: MachineDef<S, E, C>, owner: Scope, ctx: C, hooks: MachineHooks = {}): Machine<S, E> {
  const scope = owner.child(`machine:${def.id}`);
  const state = signal<S>(def.initial);
  let entered: Scope | undefined;
  let data: unknown;

  function go(to: S, via: string, eventData?: unknown): void {
    if (!scope.alive) return;
    const from = untracked(state);
    entered?.dispose(); // aborts the old state's invoke and clears its timers
    data = eventData;
    state(to);
    hooks.onTransition?.(def.id, from, via, to);
    enter(to);
  }

  function enter(name: S): void {
    const node = def.states[name];
    const here = scope.child(name);
    entered = here;
    for (const [ms, target] of Object.entries(node.after ?? {}) as [string, S][]) {
      here.timeout(Number(ms), () => go(target, `after ${ms}`));
    }
    if (!node.invoke) return;
    const send = (e: E, d?: unknown): void => {
      if (here.alive) m.send(e, d); // an answer for a state we left is dropped
    };
    let result: Promise<E | void> | E | void;
    try {
      result = node.invoke(ctx, here.signal, send);
    } catch (err) {
      return failed(name, here, err);
    }
    Promise.resolve(result).then(
      (e) => {
        if (e !== undefined) send(e);
      },
      (err: unknown) => failed(name, here, err),
    );
  }

  function failed(name: S, here: Scope, err: unknown): void {
    if (!here.alive) return; // aborted because we left: not a failure
    const target = def.states[name].onError;
    if (target !== undefined) go(target, 'error', err);
    else hooks.warn?.(`machine ${def.id}: ${name} failed`, String(err));
  }

  const m: Machine<S, E> = {
    id: def.id,
    state: () => state(),
    get data() {
      return data;
    },
    get alive() {
      return scope.alive;
    },
    send(event, eventData) {
      if (!scope.alive) return false;
      const target = def.states[untracked(state)].on?.[event];
      if (target === undefined) return false;
      go(target, event, eventData);
      return true;
    },
    stop: () => scope.dispose(),
  };
  enter(def.initial);
  return m;
}

// ---------- path generation for model-based tests (the testkit walks these) ----------

export type Step<E extends string> = { kind: 'event'; event: E } | { kind: 'after'; ms: number } | { kind: 'error' };

export interface Transition<S extends string, E extends string> {
  readonly from: S;
  readonly via: Step<E>;
  readonly to: S;
}

export interface MachinePaths<S extends string, E extends string> {
  /** the shortest way from `initial` into each reachable state */
  readonly states: readonly { state: S; path: readonly Step<E>[] }[];
  /** every transition, each with the shortest path that takes it */
  readonly transitions: readonly { transition: Transition<S, E>; path: readonly Step<E>[] }[];
  /** states no path reaches: a model-based test fails on them */
  readonly unreachable: readonly S[];
}

export function transitionsOf<S extends string, E extends string, C>(def: MachineDef<S, E, C>): Transition<S, E>[] {
  const out: Transition<S, E>[] = [];
  for (const from of Object.keys(def.states) as S[]) {
    const node: StateNode<S, E, C> = def.states[from];
    for (const [event, to] of Object.entries(node.on ?? {}) as [E, S | undefined][]) {
      if (to !== undefined) out.push({ from, via: { kind: 'event', event }, to });
    }
    for (const [ms, to] of Object.entries(node.after ?? {}) as [string, S][]) out.push({ from, via: { kind: 'after', ms: Number(ms) }, to });
    if (node.onError !== undefined) out.push({ from, via: { kind: 'error' }, to: node.onError });
  }
  return out;
}

export function paths<S extends string, E extends string, C>(def: MachineDef<S, E, C>): MachinePaths<S, E> {
  const all = transitionsOf(def);
  const reach = new Map<S, readonly Step<E>[]>([[def.initial, []]]);
  const queue: S[] = [def.initial];
  for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
    const here = reach.get(s) ?? [];
    for (const t of all) {
      if (t.from !== s || reach.has(t.to)) continue;
      reach.set(t.to, [...here, t.via]);
      queue.push(t.to);
    }
  }
  const names = Object.keys(def.states) as S[];
  return {
    states: names.flatMap((state) => {
      const path = reach.get(state);
      return path ? [{ state, path }] : [];
    }),
    transitions: all.flatMap((transition) => {
      const prefix = reach.get(transition.from);
      return prefix ? [{ transition, path: [...prefix, transition.via] }] : [];
    }),
    unreachable: names.filter((s) => !reach.has(s)),
  };
}
