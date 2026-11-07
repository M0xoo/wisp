// This Mac's writes (design/machine.md "Acting on it"), each a command to the peer the pane shows,
// with the patch the pane shows at once: a stopped row goes, a pause shows paused. A refusal rolls
// the patch back and the shell's toast says why. Ids follow the owning plugins' api crates:
// runtime.stop, later.add, worktrees.clean; machine.* and automations pause are wisp.machine's
// (asked of its Rust agent in the report).

import { defineCommand, entityKey, type CommandDef, type EntityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';
import type { PatchOp } from '@wisp/protocol';
import { LOAD, SNAPSHOT, THIS, type MachineLoad, type MachineSnapshot } from './types.ts';

type ArrayKey = 'tasks' | 'crew' | 'leftovers' | 'reclaim';
interface Item {
  readonly id?: string;
  readonly pid?: number;
  readonly kind?: string;
  readonly ids?: readonly string[];
}

/** Removes the items `drop` picks from one of the snapshot's lists, last first so indexes hold. */
export function dropFrom(base: EntityReader, peer: PeerId, list: ArrayKey, drop: (x: Item) => boolean): EntityOps {
  const key = entityKey(peer, THIS);
  const m = base.peek<MachineSnapshot>(SNAPSHOT, key);
  if (!m) return [];
  const items = m[list] as readonly Item[];
  const ops: PatchOp[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x && drop(x)) ops.push({ op: 'remove', path: `/${list}/${i}` });
  }
  return ops.length ? [{ e: SNAPSHOT, id: key, op: 'patch', ops }] : [];
}

/** The pause on both readings, so the chip and the pane agree at once. */
function pauseOps(base: EntityReader, peer: PeerId, until: number): EntityOps {
  const key = entityKey(peer, THIS);
  const out: EntityOps[number][] = [];
  if (base.peek<MachineSnapshot>(SNAPSHOT, key)) out.push({ e: SNAPSHOT, id: key, op: 'patch', ops: [{ op: 'replace', path: '/guard/pausedUntil', value: until }] });
  if (base.peek<MachineLoad>(LOAD, key)) out.push({ e: LOAD, id: key, op: 'patch', ops: [{ op: 'replace', path: '/pausedUntil', value: until }] });
  return out;
}

const covers = (ids: readonly string[] | undefined, g: { ids?: readonly string[] }): boolean => !!ids && !!g.ids && g.ids.length > 0 && g.ids.every((i) => ids.includes(i));

const sameTask = (a: string, b: string, peer: PeerId): boolean => entityKey(peer, a) === entityKey(peer, b);

/** Stops one running task (its own Stop): the row goes from What's using it, and a crew row whose jobs all stopped. */
export const stopTask = defineCommand<{ id: EntityKey }>({
  id: 'runtime.stop',
  owner: (a) => a.id,
  optimistic: (base, a) => {
    const peer = a.id.slice(0, a.id.indexOf(':')) as PeerId;
    return dropFrom(base, peer, 'tasks', (x) => x.id !== undefined && sameTask(x.id, a.id, peer));
  },
});

export interface MachineCommands {
  readonly stopPid: CommandDef<{ pid: number }>;
  readonly pause: CommandDef<{ until: number }>;
  readonly clean: CommandDef<{ ids?: readonly string[]; leftovers?: readonly string[] }>;
  readonly harnessClean: CommandDef<{ ids?: readonly string[] }, { removed: number; freed: number }>;
  readonly fix: CommandDef<{ group: string }, { crew?: string; session?: string; queued?: boolean }>;
  readonly later: CommandDef<{ sessionId: string; text: string; at: number }>;
}

/** The commands for one peer's machine: their owner is that peer, whatever the args. */
export function machineCommands(peer: PeerId): MachineCommands {
  return {
    stopPid: defineCommand({ id: 'machine.stop', owner: () => peer, optimistic: (base, a) => dropFrom(base, peer, 'leftovers', (x) => x.pid === a.pid) }),
    pause: defineCommand({ id: 'machine.pauseAutomations', owner: () => peer, optimistic: (base, a) => pauseOps(base, peer, a.until) }),
    clean: defineCommand({
      id: 'worktrees.clean',
      owner: () => peer,
      // the group these ids make up goes (worktrees.clean takes task ids, or folder names for leftovers)
      optimistic: (base, a) => dropFrom(base, peer, 'reclaim', (x) => (a.leftovers ? x.kind === 'leftover' : x.kind !== 'leftover' && x.kind !== 'harness' && covers(a.ids, x))),
    }),
    harnessClean: defineCommand({ id: 'machine.harnessClean', owner: () => peer, optimistic: 'none' }),
    fix: defineCommand({ id: 'machine.fix', owner: () => peer, optimistic: 'none' }),
    later: defineCommand({ id: 'later.add', owner: (a) => entityKey(peer, a.sessionId), optimistic: 'none' }),
  };
}
