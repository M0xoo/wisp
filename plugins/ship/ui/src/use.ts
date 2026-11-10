// What every Ship it component reads the same way: the task row, the reviewer's name, the flows,
// "3m ago", and the ways to open the PR pane and the Ship it dialog.

import { createMemo, type Accessor } from 'solid-js';
import { type EntityKey, type Json, type PluginClient, type SessionId } from '@wisp/client';
import { englishT, timeLabel, useSignal } from '@wisp/ui';
import { flowsFor, type TaskFlows } from './flows.ts';
import { t as tr } from './i18n.ts';
import type { ReviewContext } from './model/review.ts';
import { guessShip } from './model/ship.ts';
import { useShell, type ShipShell } from './shell.ts';
import { AGENT, SESSION, type AgentRow, type ShipSession } from './types.ts';

export const SHIP_VIEW = 'ship.dialog'; // in the plugin's namespace, as every view id is

export function useSession(client: PluginClient, key: () => EntityKey | undefined): Accessor<ShipSession | undefined> {
  const row = createMemo(() => {
    const k = key();
    return k ? useSignal(client.entities.row<ShipSession>(SESSION, k)) : undefined;
  });
  return () => row()?.() as ShipSession | undefined;
}

/** Who reviews: the agents' names, and whether Settings → Review by another harness is on. */
export function useReviewCtx(client: PluginClient, s: Accessor<ShipSession | undefined>): Accessor<ReviewContext> {
  const agents = useSignal(client.entities.list<AgentRow>(AGENT));
  return () => ({
    reviewOn: s()?.reviewOn === true,
    agentName: (id) => (id ? agents().find((a) => a.id === id)?.name : undefined),
  });
}

/** "3m ago", the kit's way. */
export const ago = (now: () => number) => (at: number): string => timeLabel(at, now(), englishT);

export interface Ship {
  readonly shell: ShipShell;
  readonly flows: TaskFlows;
  /** Opens the side panel on PR, beside the task (it brings the task along). */
  openPane(): void;
  /** Opens Ship it, guessed from the row so it opens in its final shape. */
  openShip(s: ShipSession | undefined): void;
}

export function useShip(client: PluginClient, key: EntityKey): Ship {
  const shell = useShell();
  const flows = flowsFor(client, () => shell, key);
  return {
    shell,
    flows,
    openPane: () => client.navigate({ t: 'openSide', side: { kind: 'pr', id: key as string as SessionId } }),
    openShip: (s) => openShip(client, shell, key, s),
  };
}

export function openShip(client: PluginClient, shell: ShipShell, key: EntityKey, s: ShipSession | undefined): void {
  if (s?.state === 'running' || s?.state === 'waiting') {
    shell.toast.show(tr('wisp.ship.toast.stillWorking'));
    return;
  }
  const params = { key, guess: guessShip(s) } as unknown as Json;
  client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: SHIP_VIEW as never, params } });
}
