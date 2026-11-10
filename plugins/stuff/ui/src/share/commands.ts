// Sharing's writes and its two questions, as commands (v1 routes in server/routes/sessions.js, one
// each): GET /sessions/:id/share → share.preview, POST → share.create, DELETE → share.stop,
// POST /shares/peek → share.peek, POST /shares/import → share.import. The questions return their
// answer in the ack and change nothing, so they declare no optimistic patch.

import { defineCommand, type EntityKey, type EntityOps, type EntityReader } from '@wisp/client';
import type { ImportArgs, ShareCardInfo, Shared, SharePreview } from './types.ts';

/** The summary row's entity kind (the runtime plugin's, read through the store). */
export const SESSION = 'session';

/** `<peer>:<id>` → `<id>`: the key routes the command, the peer reads its own id. */
const bare = (k: string): string => k.slice(k.indexOf(':') + 1);

const sharedOf = (base: EntityReader, key: EntityKey): unknown => (base.peek<{ shared?: unknown }>(SESSION, key) ?? {}).shared;

/** What a share of the task would carry, and where it would go. */
export const sharePreview = defineCommand<{ session: EntityKey }, SharePreview>({
  id: 'share.preview',
  owner: (a) => a.session,
  wire: (a) => ({ id: bare(a.session) }),
  optimistic: 'none', pending: 'the share.preview control',
});

/** Share it (or update its link): '' passkey for anyone with the link. The link's row comes with
 *  the session's next patch; the dialog shows it from the answer, so nothing waits on the list. */
export const shareCreate = defineCommand<{ session: EntityKey; passkey?: string; work: boolean }, Shared>({
  id: 'share.create',
  owner: (a) => a.session,
  wire: (a) => ({ session: bare(a.session), ...(a.passkey !== undefined && { passkey: a.passkey }), work: a.work }),
  optimistic: 'none', pending: 'the share.create control',
  // a second click while one is packing is the same share
  dedupe: (a) => a.session,
});

/** Stop sharing: the link goes at once; a refusal (signed out of that grid) brings it back. */
export const shareStop = defineCommand<{ session: EntityKey }>({
  id: 'share.stop',
  owner: (a) => a.session,
  wire: (a) => ({ session: bare(a.session) }),
  optimistic: (base, a): EntityOps => (sharedOf(base, a.session) === undefined ? [] : [{ e: SESSION, id: a.session, op: 'patch', ops: [{ op: 'remove', path: '/shared' }] }]),
});

/** The card for a link pasted in New task: who shared it and what importing it would do here. */
export const sharePeek = defineCommand<{ home: string; url: string; passkey?: string }, ShareCardInfo>({
  id: 'share.peek',
  owner: (a) => a.home,
  wire: (a) => ({ url: a.url, ...(a.passkey !== undefined && { passkey: a.passkey }) }),
  optimistic: 'none', pending: 'the share.peek control',
});

/** Carry it on here: the task, its history, work and team; what's typed is its first follow-up. */
export const shareImport = defineCommand<ImportArgs & { home: string }, { id: string; title?: string; notes?: readonly string[] }>({
  id: 'share.import',
  owner: (a) => a.home,
  // the new task's row arrives with the list's patch; New task shows its own pending card
  optimistic: 'none', pending: 'the share.import control',
  dedupe: (a) => `${a.url}\u0000${a.prompt}`,
});

export const SHARE_COMMANDS = [sharePreview, shareCreate, shareStop, sharePeek, shareImport] as const;
