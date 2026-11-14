// Save to My Stuff, the pure half (./keep.ts is the host): wisp.stuff's commands as a reply's buttons send them, the
// key a thing is kept under, and the placeholder card My Stuff shows until the peer answers.
import { defineCommand, type EntityKey, type PeerId } from '@wisp/client';
import type { KeepWhat } from '@wisp/ui';

export const ITEM = 'stuff.item';

export interface Kept {
  readonly id: string;
  /** the placeholder, until the peer's row comes */
  readonly pending?: boolean;
  readonly from?: { readonly key?: string };
}

export interface SaveArgs {
  readonly peer: PeerId;
  readonly temp: EntityKey;
  readonly file?: string;
  readonly text?: string;
  readonly name?: string;
  readonly lang?: string;
  readonly title?: string;
  readonly from: { readonly session: string; readonly turn: string; readonly key: string };
  readonly shown: Readonly<Record<string, unknown>>;
}

/** wisp.stuff's `stuff.save` (plugins/stuff/api): a card at the top of My Stuff at once, filled in by the answer. */
export const keepSave = defineCommand<SaveArgs, { id: string }>({
  id: 'stuff.save',
  owner: (a) => a.peer,
  wire: (a) => ({
    ...(a.file !== undefined && { file: a.file }),
    ...(a.text !== undefined && { text: a.text }),
    ...(a.name && { name: a.name }),
    ...(a.lang && { lang: a.lang }),
    ...(a.title && { title: a.title }),
    from: a.from,
    by: 'you',
  }),
  optimistic: (_base, a) => [{ e: ITEM, id: a.temp, op: 'upsert', v: { ...a.shown, pending: true } }],
  dedupe: (a) => `stuff.save:${a.from.key}`,
});

/** wisp.stuff's `stuff.remove`: the card goes at once. */
export const keepRemove = defineCommand<{ readonly key: EntityKey; readonly id: string }, { ok: boolean }>({
  id: 'stuff.remove',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id }),
  optimistic: (_base, a) => [{ e: ITEM, id: a.key, op: 'del' }],
});

/** The key a button's thing is kept under (v1 keyOf: `<task>|<turn>|<what>`). */
export const keepKey = (task: string, turn: string, what: string): string => `${task}|${turn}|${what}`;

/** The placeholder card My Stuff shows until the peer's own row arrives. */
export function shownOf(id: string, it: KeepWhat, key: string, at: number): Readonly<Record<string, unknown>> {
  const name = it.name ?? (it.path ?? '').split(/[\\/?#]/).filter(Boolean).pop() ?? '';
  const size = it.text === undefined ? 0 : new TextEncoder().encode(it.text).length;
  return {
    id,
    kind: it.kind,
    name,
    title: it.title ?? name,
    size,
    at,
    by: 'you',
    from: { key },
    ...(it.text !== undefined && { excerpt: it.text.slice(0, 1400) }),
    ...(it.lang && { lang: it.lang }),
  };
}

