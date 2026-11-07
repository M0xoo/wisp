// What the dispatcher and the context factory need from the kernel, so neither imports kernel.ts.
import type { Caller, CallContext, Clock, Log, PluginContext, PluginId } from './contract.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { EventBus } from './events.ts';
import type { Timers } from './scope.ts';
import type { ActiveCall } from './trace-context.ts';

/** The testkit's levers (plan §6.10, §6.11.2 rule 8): random tie order and injected slowness. */
export interface TestHooks {
  /** extra milliseconds before an interceptor runs */
  interceptorDelay?: (plugin: string, hook: string) => number;
  /** a random number in [0, 1): interceptors of equal priority are shuffled with it */
  random?: () => number;
}

export interface DispatchHost {
  readonly clock: Clock;
  readonly log: Log;
  readonly timers: Timers;
  readonly diagnostics: Diagnostics;
  readonly events: EventBus;
  readonly testHooks: TestHooks | undefined;
  readonly transaction: (<R>(fn: () => Promise<R>) => Promise<R>) | undefined;
  isActive(plugin: string): boolean;
  /** activate whatever waits on `onCommand:<cmd>` (args may narrow it) */
  activateForCommand(cmd: string, args: unknown): Promise<void>;
  /** why `plugin` may not use `permission`, or undefined */
  checkPlugin(plugin: string, permission: string): string | undefined;
  /** why `caller` may not use `permission`, or undefined */
  checkCaller(caller: Caller, permission: string): string | undefined;
  callContext(plugin: PluginId, active: ActiveCall): CallContext;
  pluginContext(plugin: PluginId): PluginContext;
}
