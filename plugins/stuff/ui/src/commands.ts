// My Stuff's writes (plugins/stuff/api/src/commands.rs). Each runs on the peer that keeps the item
// and shows at once through its optimistic patch on the `stuff.item` row; a refusal rolls it back
// and the shell shows the red toast. `key` is the row's entity key (`<peer>:<id>`); `id` is what the
// peer reads. Removal is the one exception to "at once": the page hides the card and runs
// `stuff.remove` once the Undo toast has gone (v1), so it needs no undelete.

import { defineCommand, type EntityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';
import { ITEM, type Grant, type Launched, type Starter, type StuffFrom, type StuffView } from './types.ts';

export interface ItemArgs {
  readonly key: EntityKey;
  readonly id: string;
}

const rowOf = (base: EntityReader, key: EntityKey): StuffView | undefined => base.peek<StuffView>(ITEM, key) as StuffView | undefined;

/** The row with these fields set (undefined drops one): the whole row, so the patch never misses. */
/** Set fields of a row the reader holds; a field set to undefined is removed. */
export function merged(base: EntityReader, key: EntityKey, fields: { readonly [K in keyof StuffView]?: unknown }): EntityOps {
  const row = rowOf(base, key);
  if (!row) return [];
  const v: Record<string, unknown> = { ...row, ...fields };
  for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  return [{ e: ITEM, id: key, op: 'upsert', v }];
}

export interface UpdateArgs extends ItemArgs {
  readonly title?: string;
  readonly note?: string;
  readonly tags?: readonly string[];
  readonly starred?: boolean;
}

/** Rename, note, tags, star. */
export const updateItem = defineCommand<UpdateArgs, StuffView>({
  id: 'stuff.update',
  owner: (a) => a.key,
  optimistic: (base, a) => {
    const { key: _k, id: _i, ...fields } = a;
    return merged(base, a.key, { ...fields, ...(fields.tags && { tags: [...fields.tags] }) });
  },
});

export const removeItem = defineCommand<ItemArgs, { ok: boolean }>({
  id: 'stuff.remove',
  owner: (a) => a.key,
  optimistic: (_base, a) => [{ e: ITEM, id: a.key, op: 'del' }],
});

/** Back to the one previous version: the server swaps them, so the page waits for its answer. */
export const restoreItem = defineCommand<ItemArgs, StuffView>({ id: 'stuff.restore', owner: (a) => a.key, optimistic: 'none' });

/** Launch: Starting… shows on its card at once; the port comes with the answer. */
export const launchApp = defineCommand<ItemArgs, Launched>({
  id: 'stuff.launch',
  owner: (a) => a.key,
  optimistic: (base, a) => merged(base, a.key, { running: rowOf(base, a.key)?.running ?? { port: 0 } }),
  // a pane and the app's window may both ask while it starts: one start
  dedupe: (a) => `stuff.launch:${a.key}`,
});

export const stopApp = defineCommand<ItemArgs, { ok: boolean }>({
  id: 'stuff.stop',
  owner: (a) => a.key,
  optimistic: (base, a) => merged(base, a.key, { running: undefined }),
});

/** Reset data: the app's database goes, made again from its seed the next time it asks. */
export const resetData = defineCommand<ItemArgs, StuffView>({
  id: 'stuff.resetData',
  owner: (a) => a.key,
  optimistic: (base, a) => merged(base, a.key, { data: false }),
});

export interface AllowArgs extends ItemArgs {
  readonly uses: readonly string[];
  /** the task it's shown on: no new scope while that task runs in Full auto (the peer checks) */
  readonly task?: string;
}

/** What you allow a pane; [] takes back access. Only the user's capability set holds `stuff:allow`. */
export const allowPane = defineCommand<AllowArgs, StuffView>({
  id: 'stuff.allow',
  owner: (a) => a.key,
  optimistic: (base, a) => merged(base, a.key, { allowed: a.uses.length ? [...a.uses] : undefined, changed: undefined }),
});

/** The server's word on what a pane may do now: asked before every write a pane makes. */
export const grantOf = defineCommand<ItemArgs, Grant>({ id: 'stuff.grant', owner: (a) => a.key, optimistic: 'none' });

/** Publish (again, after a change) to your wisp Grid: a link anyone can open. */
export const publishApp = defineCommand<ItemArgs, StuffView>({
  id: 'stuff.publish',
  owner: (a) => a.key,
  optimistic: (base, a) => merged(base, a.key, { publishing: true }),
});

export const unpublishApp = defineCommand<ItemArgs, StuffView>({
  id: 'stuff.unpublish',
  owner: (a) => a.key,
  optimistic: (base, a) => merged(base, a.key, { published: undefined }),
});

export interface SaveArgs {
  readonly peer: PeerId;
  /** the placeholder row shown until the peer's own arrives */
  readonly temp: EntityKey;
  readonly text?: string;
  readonly url?: string;
  readonly name?: string;
  readonly lang?: string;
  readonly title?: string;
  readonly from?: StuffFrom;
  readonly by?: 'you';
  /** the placeholder's look: kind, size, excerpt */
  readonly shown: StuffView;
}

/** Save a reply's text or link to My Stuff: a card at the top at once, filled in by the answer. */
export const saveItem = defineCommand<SaveArgs, StuffView>({
  id: 'stuff.save',
  owner: (a) => a.peer,
  optimistic: (_base, a) => [{ e: ITEM, id: a.temp, op: 'upsert', v: { ...a.shown, pending: true } }],
});

/** The panes wisp ships (v1 GET /stuff/starters). */
export const listStarters = defineCommand<{ readonly peer: PeerId }, { starters: Starter[] }>({ id: 'stuff.starters', owner: (a) => a.peer, optimistic: 'none' });

/** Adds a starter to My Stuff once (it grants and pins nothing). */
export const addStarter = defineCommand<{ readonly peer: PeerId; readonly id: string }, StuffView>({ id: 'stuff.addStarter', owner: (a) => a.peer, optimistic: 'none' });

/** Make a pane: a task of kind `pane` on your defaults, in an empty folder of its own. */
export const makePane = defineCommand<{ readonly peer: PeerId; readonly prompt: string; readonly agent?: string; readonly model?: string; readonly effort?: string; readonly account?: string; readonly ext: { 'wisp.stuff': { kind: 'pane' } } }, { id: string }>({
  id: 'runtime.create',
  owner: (a) => a.peer,
  optimistic: 'none',
});

/** Show in folder: the peer opens its file manager; through a proxy it answers the path instead. */
export const revealItem = defineCommand<ItemArgs, { ok: boolean; path?: string }>({ id: 'stuff.reveal', owner: (a) => a.key, optimistic: 'none' });

/** Where an app can be published (the publisher's targets): your wisp Grids, by host. */
export const publishTargets = defineCommand<{ readonly peer: PeerId }, { host: string }[]>({ id: 'stuff.targets', owner: (a) => a.peer, optimistic: 'none' });

export const STUFF_COMMANDS = [updateItem, removeItem, restoreItem, launchApp, stopApp, resetData, allowPane, grantOf, publishApp, unpublishApp, saveItem, listStarters, addStarter, revealItem, publishTargets] as const;
