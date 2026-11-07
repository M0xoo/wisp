// The two flows Ship it runs per task (plan §4.6.3: flows are machines), owned by the plugin's
// scope so they outlive the dialog and the row that started them:
//   ship   idle → sending → idle | failed; a failure stays on the row with Retry (the dialog again,
//          with what was typed) and × (dismiss). v1 kept this in a module Map (`ships`).
//   merge  idle → confirming → merging → idle. The confirm sits by the button; while merging the
//          button holds its width with a ring.
// A late answer for a state already left is dropped by the machine runtime (#435, #492).

import { signal, type EntityKey, type Machine, type PluginClient, type Readable } from '@wisp/client';
import { merge as mergeCmd, ship as shipCmd } from './commands.ts';
import { t as tr } from './i18n.ts';
import { mergedToast } from './model/merge.ts';
import { shippedToast } from './model/ship.ts';
import type { ShipShell } from './shell.ts';
import type { ShipStep, ShipValues } from './types.ts';

export interface ShipRun {
  readonly steps: readonly ShipStep[];
  readonly values: ShipValues;
  readonly update: boolean;
  readonly error?: string;
}

export type ShipState = 'idle' | 'sending' | 'failed';
export type MergeState = 'idle' | 'confirming' | 'merging';
export type MergeEvent = 'ask' | 'cancel' | 'confirm' | 'done';

export interface TaskFlows {
  readonly ship: Machine<ShipState, 'send' | 'dismiss'>;
  /** the run in flight or the one that failed; undefined when idle */
  readonly run: Readable<ShipRun | undefined>;
  start(run: Omit<ShipRun, 'error'>): void;
  dismiss(): void;
  readonly merge: Machine<MergeState, MergeEvent>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function shipFlow(client: PluginClient, shell: () => ShipShell, key: EntityKey): Pick<TaskFlows, 'ship' | 'run' | 'start' | 'dismiss'> {
  const run = signal<ShipRun | undefined>(undefined);
  const ship = client.machine<ShipState, 'send' | 'dismiss', void>(
    {
      id: `wisp.ship.ship:${key}`,
      initial: 'idle',
      states: {
        idle: { on: { send: 'sending' } },
        sending: {
          async invoke() {
            const r = run();
            if (!r) return;
            try {
              const out = await client.run(shipCmd, { key, ...r.values, update: r.update, first: r.steps[0] ?? 'push' });
              run(undefined);
              const url = out.url;
              shell().toast.success(shippedToast(tr, out, r.update), { duration: 8000, ...(url && { action: { label: tr('wisp.ship.toast.open'), onClick: () => shell().platform.openExternal(url) } }) });
            } catch (err) {
              // the shell's toast already says why (the command's reject); the row keeps it too
              run({ ...r, error: errorText(err) });
              throw err;
            }
          },
          onError: 'failed',
        },
        failed: { on: { send: 'sending', dismiss: 'idle' } },
      },
    },
    undefined,
  );
  return {
    ship,
    run,
    start(r) {
      run({ ...r });
      ship.send('send');
    },
    dismiss() {
      run(undefined);
      ship.send('dismiss');
    },
  };
}

function mergeFlow(client: PluginClient, shell: () => ShipShell, key: EntityKey): TaskFlows['merge'] {
  return client.machine<MergeState, MergeEvent, void>(
    {
      id: `wisp.ship.merge:${key}`,
      initial: 'idle',
      states: {
        idle: { on: { ask: 'confirming' } },
        confirming: { on: { cancel: 'idle', confirm: 'merging' } },
        merging: {
          async invoke() {
            const r = await client.run(mergeCmd, { key });
            const done = mergedToast(tr, r);
            if (done.ok) shell().toast.success(done.text, { duration: 10_000 });
            else shell().toast.error(done.text);
            return 'done';
          },
          on: { done: 'idle' },
          // a refusal: the shell's toast says why, and Merge is back
          onError: 'idle',
        },
      },
    },
    undefined,
  );
}

const registry = new WeakMap<PluginClient, Map<EntityKey, TaskFlows>>();

/** The flows of one task, made on first use and kept while the plugin is on. */
export function flowsFor(client: PluginClient, shell: () => ShipShell, key: EntityKey): TaskFlows {
  let byKey = registry.get(client);
  if (!byKey) registry.set(client, (byKey = new Map()));
  const have = byKey.get(key);
  if (have) return have;
  const made: TaskFlows = { ...shipFlow(client, shell, key), merge: mergeFlow(client, shell, key) };
  byKey.set(key, made);
  return made;
}
