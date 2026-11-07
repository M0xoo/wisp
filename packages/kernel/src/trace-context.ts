// Which call is running right now, so a nested `run` (even through the setup ctx) joins the trace and a
// timer or event handler never inherits a call that already ended.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Caller, PluginId, Trace } from './contract.ts';

export interface RootState {
  /** events emitted during this root command: published after it commits */
  events: { plugin: PluginId; type: string; data: unknown }[];
  /** `then` follow-ups from vetoes: run after it settles, each as a new root */
  followUps: { cmd: string; args: unknown; caller: Caller }[];
}

export interface ActiveCall {
  trace: Trace;
  root: RootState;
  /** whose code is running: the command's owner, or the interceptor's plugin */
  plugin: PluginId;
}

export const current = new AsyncLocalStorage<ActiveCall>();

/** Run `fn` outside any call: a timer, an event delivery, a follow-up. */
export const detached = <R>(fn: () => R): R => current.exit(fn);
