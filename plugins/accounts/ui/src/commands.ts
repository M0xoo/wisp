// wisp.accounts' writes (ids as in the TS reference's COMMANDS, v1 routes in brackets). Each says what
// shows at once; a refusal rolls it back and the shell toasts it. Reads that only probe (Re-check,
// Test) change nothing on screen before the answer, so they are 'none'.

import { defineCommand, entityKey, type EntityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';
import {
  ACCOUNT,
  HARNESS,
  KEY,
  LOGIN,
  accountId,
  keyId,
  loginId,
  type AccountArgs,
  type AccountRow,
  type AddArgs,
  type AgentArgs,
  type HarnessRow,
  type KeyRow,
  type KeySetArgs,
  type LoginArgs,
  type LoginInputArgs,
  type LoginRow,
  type ProviderArgs,
  type RecheckArgs,
  type UpdateArgs,
} from './types.ts';

const at = (peer: PeerId, id: string): EntityKey => entityKey(peer, id);

/** Upsert `kind/id` with `change` over what's there; nothing when the row isn't. */
function merge<T extends object>(base: EntityReader, kind: string, id: EntityKey, change: Partial<T>): EntityOps {
  const row = base.peek<T>(kind, id);
  return row ? [{ e: kind, id, op: 'upsert', v: { ...row, ...change } }] : [];
}

/** The harness's accounts in their order. */
export function accountsOf(base: EntityReader, agent: string): AccountRow[] {
  return base
    .keys(ACCOUNT)()
    .map((k) => base.peek<AccountRow>(ACCOUNT, k) as AccountRow | undefined)
    .filter((r): r is AccountRow => r !== undefined && r.agent === agent)
    .sort((a, b) => a.ord - b.ord);
}

/** Re-check (POST /agents/recheck): look for harnesses and models again, here and on every machine. */
export const recheck = defineCommand<RecheckArgs>({ id: 'accounts.recheck', owner: (a) => a.peer, optimistic: 'none', pending: 'the accounts.recheck control' });

/** Install (opencode, into ~/.wisp/tools). */
export const install = defineCommand<AgentArgs>({
  id: 'accounts.install',
  owner: (a) => a.peer,
  optimistic: (base, a) => merge<HarnessRow>(base, HARNESS, at(a.peer, a.agent), { installing: true }),
});

/** Trust this version (POST /agents/:id/trust): the change notice goes at once. */
export const trust = defineCommand<AgentArgs>({
  id: 'accounts.watch.trust',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const id = at(a.peer, a.agent);
    const row = base.peek<HarnessRow>(HARNESS, id);
    if (!row) return [];
    const { changed: _gone, ...rest } = row;
    return [{ e: HARNESS, id, op: 'upsert', v: { ...rest, pinnedAt: Date.now() } }];
  },
});

const starting = (a: LoginArgs, was: LoginRow | undefined): LoginRow => ({ agent: a.agent, account: a.account, state: 'running', url: '', code: '', error: '', needsInput: false, checking: false, signedIn: was?.signedIn ?? null });

/** Add another account (POST /agents/:id/accounts): its row, and its sign-in under it, at once. */
export const addAccount = defineCommand<AddArgs>({
  id: 'accounts.add',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const last = accountsOf(base, a.agent).at(-1);
    const row: AccountRow = { agent: a.agent, id: a.id, ord: (last?.ord ?? 0) + 1, label: a.label, email: '', plan: '', default: false, kind: a.kind, state: 'signedOut', until: null, why: '' };
    const login = starting({ peer: a.peer, agent: a.agent, account: a.id }, undefined);
    return [
      { e: ACCOUNT, id: at(a.peer, accountId(a.agent, a.id)), op: 'upsert', v: row },
      { e: LOGIN, id: at(a.peer, loginId(a.agent, a.id)), op: 'upsert', v: login },
    ];
  },
});

/** Rename, make it work / personal, move up or down (PATCH /agents/:id/accounts/:acc). */
export const updateAccount = defineCommand<UpdateArgs>({
  id: 'accounts.update',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const id = at(a.peer, accountId(a.agent, a.account));
    if (!a.move) return merge<AccountRow>(base, ACCOUNT, id, { ...(a.label !== undefined && { label: a.label }), ...(a.kind && { kind: a.kind }) });
    const list = accountsOf(base, a.agent);
    const i = list.findIndex((x) => x.id === a.account);
    const other = list[i + (a.move === 'up' ? -1 : 1)];
    const self = list[i];
    if (!self || !other) return [];
    return [
      { e: ACCOUNT, id, op: 'upsert', v: { ...self, ord: other.ord } },
      { e: ACCOUNT, id: at(a.peer, accountId(a.agent, other.id)), op: 'upsert', v: { ...other, ord: self.ord } },
    ];
  },
});

/** Remove (DELETE /agents/:id/accounts/:acc): signs it out and forgets it. */
export const removeAccount = defineCommand<AccountArgs>({
  id: 'accounts.remove',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const login = at(a.peer, loginId(a.agent, a.account));
    return [{ e: ACCOUNT, id: at(a.peer, accountId(a.agent, a.account)), op: 'del' }, ...(base.peek(LOGIN, login) ? [{ e: LOGIN, id: login, op: 'del' as const }] : [])];
  },
});

/** Sign in (POST /agents/:id/login): the panel shows at once and fills in as the CLI talks. */
export const loginStart = defineCommand<LoginArgs>({
  id: 'accounts.login.start',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const id = at(a.peer, loginId(a.agent, a.account));
    return [{ e: LOGIN, id, op: 'upsert', v: starting(a, base.peek<LoginRow>(LOGIN, id) as LoginRow | undefined) }];
  },
});

/** The code pasted back (POST /agents/:id/login/input): a spinner while the CLI checks it. */
export const loginInput = defineCommand<LoginInputArgs>({
  id: 'accounts.login.input',
  owner: (a) => a.peer,
  optimistic: (base, a) => merge<LoginRow>(base, LOGIN, at(a.peer, loginId(a.agent, a.account)), { checking: true, needsInput: false }),
});

/** Cancel (DELETE /agents/:id/login): "Starting the sign-in…" and Cancel go at once. */
export const loginCancel = defineCommand<LoginArgs>({
  id: 'accounts.login.cancel',
  owner: (a) => a.peer,
  optimistic: (base, a) => merge<LoginRow>(base, LOGIN, at(a.peer, loginId(a.agent, a.account)), { state: 'cancelled', url: '', code: '', needsInput: false, checking: false }),
});

/** Sign out (POST /agents/:id/logout): signed out here at once; signed in again if the CLI refuses. */
export const logout = defineCommand<LoginArgs>({
  id: 'accounts.logout',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const ops: EntityOps[number][] = [...merge<LoginRow>(base, LOGIN, at(a.peer, loginId(a.agent, a.account)), { state: 'idle', signedIn: false })];
    if (a.account) ops.push(...merge<AccountRow>(base, ACCOUNT, at(a.peer, accountId(a.agent, a.account)), { state: 'signedOut' }));
    // The harness's own login, with no list of accounts: the harness reads signed out (v1 markSignedIn)
    else if (accountsOf(base, a.agent).length < 2) ops.push(...merge<HarnessRow>(base, HARNESS, at(a.peer, a.agent), { available: false, signedIn: false }));
    return ops;
  },
});

/** Save or replace a provider's key (POST /agents/:id/keys). The key goes; only its last 4 show. */
export const keySet = defineCommand<KeySetArgs>({
  id: 'accounts.keys.set',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const id = at(a.peer, keyId(a.agent, a.provider));
    const row = base.peek<KeyRow>(KEY, id);
    if (!row) return [];
    const { test: _old, ...rest } = row;
    return [{ e: KEY, id, op: 'upsert', v: { ...rest, set: true, hint: a.key.trim().slice(-4), savedAt: Date.now() } }];
  },
  // two saves of different keys are two runs; the key itself never becomes a dedupe string
  dedupe: (a) => `keys.set:${a.agent}/${a.provider}:${a.key.length}:${a.key.slice(-4)}`,
});

/** Remove a provider's key (DELETE /agents/:id/keys/:provider). */
export const keyRemove = defineCommand<ProviderArgs>({
  id: 'accounts.keys.remove',
  owner: (a) => a.peer,
  optimistic: (base, a) => {
    const id = at(a.peer, keyId(a.agent, a.provider));
    const row = base.peek<KeyRow>(KEY, id);
    if (!row) return [];
    const { test: _old, ...rest } = row;
    return [{ e: KEY, id, op: 'upsert', v: { ...rest, set: false, hint: '', savedAt: null } }];
  },
});

/** Test: one cheap call with the saved key; the answer lands on the row's `test`. */
export const keyTest = defineCommand<ProviderArgs>({ id: 'accounts.keys.test', owner: (a) => a.peer, optimistic: 'none', pending: 'the accounts.keys.test control' });

/** Ask before running a harness whose program changed (POST /agents/watch/ask). */
export const setAsk = defineCommand<{ peer: PeerId; on: boolean }>({
  id: 'accounts.watch.ask',
  owner: (a) => a.peer,
  wire: (a) => ({ on: a.on }),
  optimistic: (base, a) => merge<{ id: string; grid: boolean; ask: boolean }>(base, 'accounts.place', at(a.peer, 'this'), { ask: a.on }),
});
