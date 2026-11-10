// Settings → Connectors' writes (connectors-api commands.rs ids). Each shows its change at once
// (v1 painted the list before the answer too); a refusal rolls it back and the shell toasts it.

import { defineCommand, entityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';
import { KIND, type ConnectorBody, type ConnectorView, type OnPeer, type Transport } from './types.ts';

const keyOf = (peer: PeerId, id: string) => entityKey(peer, id);

/** The row, changed by `fn`; nothing when it isn't there (gone on another device). */
function change(base: EntityReader, peer: PeerId, id: string, fn: (c: ConnectorView) => ConnectorView): EntityOps {
  const k = keyOf(peer, id);
  const cur = base.peek<ConnectorView>(KIND.connector, k) as ConnectorView | undefined;
  return cur ? [{ e: KIND.connector, id: k, op: 'upsert', v: fn(cur) }] : [];
}

/** What a saved form looks like on its row before the server answers: being checked. */
export function draftRow(id: string, body: ConnectorBody, was?: ConnectorView): ConnectorView {
  const transport: Transport = body.transport ?? was?.transport ?? 'local';
  return {
    id,
    name: body.name ?? was?.name ?? '',
    transport,
    command: was?.command ?? '',
    args: was?.args ?? [],
    line: body.command ?? '',
    url: body.url ?? was?.url ?? '',
    env: (body.env ?? []).map((p) => ({ key: p.key, set: p.value !== '' || (was?.env.some((e) => e.key === p.key && e.set) ?? false) })),
    headers: (body.headers ?? []).map((p) => ({ key: p.key, set: p.value !== '' || (was?.headers.some((e) => e.key === p.key && e.set) ?? false) })),
    enabled: was?.enabled ?? true,
    test: null,
    signed_in: was?.signed_in ?? null,
    added_at: was?.added_at ?? 0,
    own: was?.own ?? [],
    testing: true,
  };
}

/** The id an added connector shows under until the server's row arrives (v1 used 'new'). */
export const pendingId = (name: string): string => `new:${name}`;

/** The server's body: the form without the routing (`peer`, `id`). */
const bodyOf = (a: OnPeer & ConnectorBody & { id?: string }): ConnectorBody => {
  const { peer: _p, id: _i, ...body } = a;
  return body;
};

export const addConnector = defineCommand<OnPeer & ConnectorBody>({
  id: 'connectors.add',
  owner: (a) => a.peer,
  wire: (a) => bodyOf(a),
  optimistic: (_base, a) => [{ e: KIND.connector, id: keyOf(a.peer, pendingId(a.name ?? '')), op: 'upsert', v: draftRow(pendingId(a.name ?? ''), a) }],
});

export const updateConnector = defineCommand<OnPeer & { id: string } & ConnectorBody>({
  id: 'connectors.update',
  owner: (a) => keyOf(a.peer, a.id),
  wire: (a) => ({ id: a.id, body: bodyOf(a) }),
  optimistic: (base, a) =>
    change(base, a.peer, a.id, (c) => {
      // the switch alone keeps the last check; anything else makes it say nothing (v1 PATCH)
      const edits = Object.keys(a).some((k) => k !== 'peer' && k !== 'id' && k !== 'enabled');
      return edits ? { ...draftRow(c.id, a, c), enabled: a.enabled ?? c.enabled } : { ...c, enabled: a.enabled ?? c.enabled };
    }),
});

export const removeConnector = defineCommand<OnPeer & { id: string }>({
  id: 'connectors.remove',
  owner: (a) => keyOf(a.peer, a.id),
  wire: (a) => ({ id: a.id }),
  optimistic: (base, a) => (base.peek(KIND.connector, keyOf(a.peer, a.id)) ? [{ e: KIND.connector, id: keyOf(a.peer, a.id), op: 'del' }] : []),
});

export const testConnector = defineCommand<OnPeer & { id: string }>({
  id: 'connectors.test',
  owner: (a) => keyOf(a.peer, a.id),
  wire: (a) => ({ id: a.id }),
  optimistic: (base, a) => change(base, a.peer, a.id, (c) => ({ ...c, testing: true })),
});

export const signOut = defineCommand<OnPeer & { id: string }>({
  id: 'connectors.signout',
  owner: (a) => keyOf(a.peer, a.id),
  wire: (a) => ({ id: a.id }),
  optimistic: (base, a) => change(base, a.peer, a.id, (c) => ({ ...c, signed_in: null })),
});

/** The sign-in page's URL; the browser comes back to wisp, and the row's signed_in says it worked. */
export const signIn = defineCommand<OnPeer & { id: string; origin: string }, { url: string }>({
  id: 'connectors.signin',
  owner: (a) => keyOf(a.peer, a.id),
  wire: (a) => ({ id: a.id, origin: a.origin }),
  optimistic: 'none', pending: 'the connectors.signin control', // nothing on the row changes until the browser comes back; the pane says "Signing in…"
});

/** Import found servers by name, or hide them (Not now): either way they leave the found list. */
export const importFound = defineCommand<OnPeer & { names: string[]; dismiss: string[] }, { skipped?: { name: string; error: string }[] }>({
  id: 'connectors.import',
  owner: (a) => a.peer,
  wire: (a) => ({ names: a.names, dismiss: a.dismiss }),
  optimistic: (base, a) =>
    [...a.names, ...a.dismiss].filter((n) => base.peek(KIND.found, keyOf(a.peer, n))).map((n) => ({ e: KIND.found, id: keyOf(a.peer, n), op: 'del' as const })),
});
