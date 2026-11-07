// Harness watch (v1 server/harness-watch.js, runner.js #watchHarness / #harnessHold, routes/meta.js
// trust, routes/sessions.js held start): wisp runs claude, codex, cursor-agent… from PATH, so a
// program swapped there would run with your keys and files. The first run of a harness pins its
// program; when that changes, the turn says so (an update as info, anything else as a warning) and
// Settings → Agents shows it until Trust this version. Nothing is held unless the setting
// `harnessAsk` is on: then before:run holds a run whose program may have changed, the hash is taken
// once it's held, and a program that was only touched goes by itself.
//
// Per-harness knowledge comes through the Harness contract only (`bin()`); no harness is named here.

import { fail } from '@wisp/kernel';
import type { CallContext, PluginContext } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import { COMMANDS, EVENTS, HOOKS, POINTS } from '@wisp-plugin/runtime-api';
import type { BeforeRunCtx, Harness, Session, Turn } from '@wisp-plugin/runtime-api';
import { COMMANDS as ACCOUNTS, PERMISSIONS, POINTS as ACCOUNT_POINTS, type AgentRowField } from '@wisp-plugin/accounts-api';
import { Fingerprints, type Change, type Which } from './watch-pin.ts';
import { HarnessWatch, watchEntity } from './watch-state.ts';
import { obj, str, why } from './shape.ts';

export const HOLD_KIND = 'harness-changed';
const BY = 'wisp.accounts';
/** v1 defaults.harnessAsk: Ask before running a changed harness, off by default */
export const SETTING_ASK = 'harnessAsk';

export interface WatchDeps {
  env?: () => Record<string, string | undefined>;
  platform?: string;
  /** a store other than the kernel's (tests) */
  store?: Store;
}

/** What a held turn carries in `held.data` (v1 turn.held.harness). */
export type HarnessHoldData = {
  agent: string;
  harness: Change | { checking: true };
  /** what the card's Start runs: trust, then release (the runtime runs it for a hold it doesn't own) */
  start: { cmd: string; args: { agent: string; sessionId: string; turnId: string } };
  /** a changed harness has no reset to wait for: Wait isn't offered */
  waits: false;
};

export function register(ctx: PluginContext, deps: WatchDeps = {}): HarnessWatch {
  const store = deps.store ?? ctx.service<Store>('store');
  const proc = ctx.service<{ which: Which }>('proc');
  const env = deps.env ?? (() => process.env);
  const watch = new HarnessWatch({ store, entity: watchEntity(store), now: () => ctx.clock.now(), prints: new Fingerprints(env, { ...(deps.platform && { platform: deps.platform }), which: (b, e) => proc.which(b, e) }) });
  /** the version each harness's detect last reported (v1 adapters detectedVersion): GET /agents rows carry it */
  const versions = new Map<string, string>();
  const harness = (id: string): Harness | undefined => ctx.contributions<Harness>(POINTS.harness).find((h) => h.id === id);
  const binOf = (id: string): string => harness(id)?.bin?.() ?? '';

  ctx.contribute<AgentRowField>(ACCOUNT_POINTS.agentRow, {
    plugin: BY,
    fields(agentId, row) {
      if (typeof row.version === 'string' && row.version) versions.set(agentId, row.version);
      return watch.view(agentId);
    },
  });

  ctx.intercept<BeforeRunCtx>({
    hook: HOOKS.beforeRun,
    priority: 10, // v1 looked at the harness before project trust and the plan's holds
    failure: 'open',
    timeoutMs: 1000,
    run: async (c) => {
      if (c.hold || ctx.settings.get<string>(SETTING_ASK) !== 'on') return { kind: 'continue' };
      const bin = binOf(c.agent);
      if (!bin || !(await watch.suspect(c.agent, bin))) return { kind: 'continue' };
      const data: HarnessHoldData = { agent: c.agent, harness: watch.change(c.agent) ?? { checking: true }, start: { cmd: ACCOUNTS.watchTrust, args: { agent: c.agent, sessionId: c.sessionId, turnId: c.turnId } }, waits: false };
      return { kind: 'modify', ctx: { ...c, hold: { by: BY, kind: HOLD_KIND, data } } };
    },
  });

  ctx.command<TrustArgs, { trusted: boolean; released?: boolean }>({
    id: ACCOUNTS.watchTrust,
    permission: PERMISSIONS.write,
    parse: parseTrust,
    run: async (a, call) => {
      if (!harness(a.agent)) throw fail('not_found', 'No such harness.', { status: 404 });
      if (!a.sessionId || !a.turnId) return { trusted: watch.trust(a.agent) };
      // Trust and start on a held turn: one only suspected was never hashed, so look first (v1 sessions.js)
      const bin = binOf(a.agent);
      if (!watch.change(a.agent) && bin) await watch.observe(a.agent, bin, versions.get(a.agent) ?? '');
      const trusted = watch.trust(a.agent);
      await call.run(COMMANDS.release, { id: a.sessionId, turnId: a.turnId, action: 'start' });
      return { trusted, released: true };
    },
  });

  ctx.on<{ sessionId: string; turnId: string; by: string; kind: string }>(EVENTS.held, async (e) => {
    if (e.data.by !== BY || e.data.kind !== HOLD_KIND) return;
    await checkHeld(ctx, watch, binOf, versions, e.data).catch((err: unknown) => ctx.log.warn(`harness watch: ${why(err)}`));
  });
  ctx.on<{ sessionId: string; turnId: string }>(EVENTS.started, async (e) => {
    await watchRun(ctx, watch, binOf, versions, e.data).catch((err: unknown) => ctx.log.warn(`harness watch: ${why(err)}`));
  });
  return watch;
}

interface TrustArgs {
  agent: string;
  /** Trust and start on a held turn: trust, then release it */
  sessionId?: string;
  turnId?: string;
}

function parseTrust(v: unknown): TrustArgs {
  const o = obj(v);
  const agent = str(o['agent']) ?? str(o['id']); // `id`: the route's :id, as v1 named it
  if (!agent) throw fail('invalid', 'agent: a harness id');
  const sessionId = str(o['sessionId']);
  const turnId = str(o['turnId']);
  return { agent, ...(sessionId && { sessionId }), ...(turnId && { turnId }) };
}

type Run = PluginContext['run'];

async function sessionOf(run: Run, id: string): Promise<Session | null> {
  return run<Session>(COMMANDS.get, { id }).catch(() => null);
}

/** v1 #harnessHold's second half: hashed once it's held; only touched → it goes, changed → the card says how */
async function checkHeld(ctx: PluginContext, watch: HarnessWatch, binOf: (id: string) => string, versions: Map<string, string>, e: { sessionId: string; turnId: string }): Promise<void> {
  const s = await sessionOf(ctx.run.bind(ctx), e.sessionId);
  const bin = s ? binOf(s.agent) : '';
  if (!s || !bin) return;
  const c = await watch.observe(s.agent, bin, versions.get(s.agent) ?? '');
  if (!c) await ctx.run(COMMANDS.release, { id: e.sessionId, turnId: e.turnId, action: 'start' });
  else await setTurnHarness(ctx.run.bind(ctx), e.sessionId, e.turnId, c);
}

/** v1 #watchHarness: every run looks at its program; a changed one is on the turn, never in its way */
async function watchRun(ctx: PluginContext, watch: HarnessWatch, binOf: (id: string) => string, versions: Map<string, string>, e: { sessionId: string; turnId: string }): Promise<void> {
  const s = await sessionOf(ctx.run.bind(ctx), e.sessionId);
  const bin = s ? binOf(s.agent) : '';
  if (!s || !bin) return;
  const run = ctx.run.bind(ctx);
  const known = watch.change(s.agent);
  if (known) await setTurnHarness(run, e.sessionId, e.turnId, known);
  const c = await watch.observe(s.agent, bin, versions.get(s.agent) ?? '');
  if (!c === !known && (!c || c.at === known?.at)) return;
  await setTurnHarness(run, e.sessionId, e.turnId, c);
}

/** turn.ext['wisp.accounts'].harness: the change this run started on (v1 turn.harness), others' fields kept */
async function setTurnHarness(run: Run | CallContext['run'], sessionId: string, turnId: string, c: Change | null): Promise<void> {
  const turns = await run<Turn[]>(COMMANDS.turns, { id: sessionId, limit: 5 }).catch((): Turn[] => []);
  const value = { ...obj(turns.find((t) => t.id === turnId)?.ext[BY]) };
  delete value['harness'];
  if (c) value['harness'] = c;
  await run(COMMANDS.turnExt, { id: sessionId, turnId, plugin: BY, value: Object.keys(value).length ? value : null });
}
