// wisp.channels: the hub every way of reaching wisp from outside goes through (plan §6.11.3). It owns
// the point `channels.transport@1` (Telegram, Slack, … are modules contributing into it), the config
// and its persistence, the phone (what a message may do to a task, through runtime's and crew's
// commands), the grid's routed messages, and v1's HTTP routes for all of it.

import type { EventEnvelope, HttpService, Json, NetService, PluginContext, PluginDef, SecretsService } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import { EVENTS as RUNTIME_EVENTS } from '@wisp-plugin/runtime-api';
import { type ActArgs, COMMANDS, EVENTS, type Msg, POINT, SETTINGS, type SessionView, type SummaryView, type TransportDef, enabledKey } from '@wisp-plugin/channels-api';
import { Hub, bad } from '@wisp-plugin/channels-api/kit';
import { makeBox } from './box.ts';
import { nodeCrypto } from './crypto.ts';
import { makePhone } from './phone.ts';
import { type RoutedIn, Routed, routedDef } from './routed.ts';
import { registerRoutes } from './routes.ts';
import { CONFIG, ChannelState, MIGRATIONS, OWNER, THREAD } from './state.ts';
import { OTHER_EVENTS } from './wisp.ts';

// @wisp/kernel doesn't export definePlugin yet: the identity, typed.
const definePlugin = <T extends PluginDef>(d: T): T => d;

const TEST_MSG: Msg = { title: '✨ wisp', text: 'Test from wisp: questions and finished tasks will show up like this.', actions: [] };

export interface InboundArgs {
  channel?: unknown;
  headers?: unknown;
  body?: unknown;
  at?: unknown;
  dropped?: unknown;
  verified?: unknown;
}

interface Finished {
  sessionId?: string;
  summary?: SummaryView & { id?: string };
  session?: SummaryView & { id?: string };
}

export default definePlugin({
  id: OWNER,
  async setup(ctx: PluginContext) {
    const store = ctx.service<Store>('store');
    store.migrate(OWNER, MIGRATIONS);
    store.register(CONFIG);
    store.register(THREAD);
    const net = ctx.service<NetService>('net');
    const box = makeBox(net, process.env);
    const routed = routedDef(() => ctx.settings.get<string>(SETTINGS.acceptChannels) === 'on');
    const defs = (): readonly TransportDef[] => [...ctx.contributions<TransportDef>(POINT), routed];
    const state = new ChannelState(ctx, store, ctx.service<SecretsService>('secrets'), defs);
    const loaded = await state.load();
    const btw = new Map<string, (b: { status: string; answer?: string; error?: string } | null) => void>();
    const afters = new Map<string, () => void>();
    const adopted = new Set<string>();
    // eslint-style forward reference: the phone and the hub need each other, through these two closures
    const ref: { hub?: Hub } = {};
    const phone = makePhone({
      ctx,
      box,
      defaultProject: () => ref.hub?.defaultProject() ?? Promise.resolve(null),
      threadStarted: (s, thread, m, err) => ref.hub?.threadStarted(s, thread ?? null, m, err),
      btw,
    });
    // A transport module came on: its secrets and switch into its config, a watch on the switch.
    const live = (): readonly TransportDef[] => {
      const list = defs();
      for (const d of list) {
        if (adopted.has(d.name)) continue;
        adopted.add(d.name);
        ctx.settings.watch(enabledKey(d.name), (v) => {
          const c = (hub.cfg[d.name] ||= {});
          if (c.enabled === (v === true)) return;
          c.enabled = v === true;
          hub.start();
        });
        void state.adopt(d, loaded.cfg).then(() => hub.start());
      }
      return list;
    };
    const hub = new Hub({
      phone,
      net,
      box,
      clock: ctx.clock,
      log: { warn: (m) => ctx.log.warn(m), info: (m) => ctx.log.info(m) },
      crypto: nodeCrypto,
      transports: live,
      state: loaded,
      persist: (s) => state.persist(s),
      persistRemote: (id, r) => state.persistRemote(id, r),
      changed: () => ctx.emit(EVENTS.changed, {}),
      timeout: (ms, fn) => ctx.scope.timeout(ms, fn),
    });
    ref.hub = hub;
    ctx.scope.add(() => hub.stop());
    registerCommands(ctx, hub, phone, afters);
    ctx.scope.add(() => void 0);
    for (const d of registerRoutes(ctx, ctx.service<HttpService>('http'), afters)) ctx.scope.add(d);
    subscribe(ctx, hub, state, btw);
    await phone.refresh();
    hub.start();
  },
});

function subscribe(ctx: PluginContext, hub: Hub, state: ChannelState, btw: Map<string, (b: { status: string; answer?: string; error?: string } | null) => void>): void {
  const warn = (err: unknown): void => ctx.log.warn(`wisp: phone: ${err instanceof Error ? err.message : String(err)}`);
  const notifyId = async (id: string | undefined, summary?: SummaryView | null): Promise<void> => {
    if (!id || !hub.on) return;
    const s = await hub.phone.session(id);
    await hub.notify(s, summary ?? null);
  };
  ctx.on<Finished>(RUNTIME_EVENTS.finished, (e) => notifyId(e.data.sessionId, e.data.summary).catch(warn));
  ctx.on<{ sessionId?: string }>(OTHER_EVENTS.askOpened, (e) => notifyId(e.data.sessionId).catch(warn));
  ctx.on<Finished>(OTHER_EVENTS.machineFinished, (e) => notifyId(e.data.session?.id, e.data.session).catch(warn));
  ctx.on<{ btw?: { id: string; status: string; answer?: string; error?: string } }>(OTHER_EVENTS.btwDone, (e: EventEnvelope<{ btw?: { id: string; status: string; answer?: string; error?: string } }>) => {
    const b = e.data.btw;
    if (b) btw.get(b.id)?.(b.status === 'dismissed' ? null : b);
  });
  ctx.on<{ id?: string }>(RUNTIME_EVENTS.deleted, (e) => {
    const id = e.data.id;
    if (!id || !hub.remoteOf(id)) return;
    hub.forget(id);
    state.dropRemote(id);
  });
  ctx.on('kernel.pluginOff', () => hub.start());
}

function inboundArgs(a: InboundArgs): { channel: string; headers: Record<string, string | string[] | undefined>; raw: Uint8Array; at: number; dropped: number; verified: boolean } {
  if (typeof a.channel !== 'string' || typeof a.body !== 'string') throw bad('channel and body are needed.');
  const headers = a.headers && typeof a.headers === 'object' ? (a.headers as Record<string, string | string[] | undefined>) : {};
  return { channel: a.channel, headers, raw: Buffer.from(a.body, 'base64'), at: Number(a.at) || 0, dropped: Number(a.dropped) || 0, verified: a.verified === true };
}

function registerCommands(ctx: PluginContext, hub: Hub, phone: { session(id: string): Promise<SessionView | null> }, afters: Map<string, () => void>): void {
  const keepAfter = (after: (() => void) | undefined): { after?: string } => {
    if (!after) return {};
    const id = hub.randomHex(8);
    afters.set(id, after);
    ctx.scope.timeout(60_000, () => afters.delete(id)); // a route that never sent its answer
    return { after: id };
  };
  ctx.command({ id: COMMANDS.view, readOnly: true, run: () => hub.view() });
  ctx.command({ id: COMMANDS.update, run: (args: unknown) => hub.update(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}) });
  ctx.command({ id: COMMANDS.test, run: async () => (await hub.send(TEST_MSG), hub.view()) });
  ctx.command({ id: COMMANDS.send, run: async (args: { msg?: Msg }) => ({ sent: hub.on && args.msg ? await hub.send(args.msg) : 0 }) });
  ctx.command({
    id: COMMANDS.notify,
    run: async (args: { sessionId?: string }) => {
      if (args.sessionId && hub.on) await hub.notify(await phone.session(args.sessionId), null);
      return {};
    },
  });
  ctx.command({ id: COMMANDS.act, run: async (args: ActArgs) => ({ line: await hub.act({ ...args, kind: args.kind }) }) });
  ctx.command({
    id: COMMANDS.inbound,
    run: async (args: InboundArgs) => {
      const a = inboundArgs(args);
      const ch = hub.transport(a.channel);
      if (!ch?.inbound) return { status: 404, body: { error: 'No such channel.' } };
      const out = await ch.inbound(a.raw, a.headers, { at: a.at, verified: a.verified });
      // Only past the channel's check: the grid clears its count on a 2xx, so anything else comes back.
      if (a.dropped > 0 && out.status >= 200 && out.status < 300) await ch.dropped?.(a.dropped);
      return { status: out.status, body: out.body, ...keepAfter(out.after) };
    },
  });
  ctx.command({
    id: COMMANDS.routed,
    run: async (args: Partial<RoutedIn>) => {
      if (typeof args.text !== 'string' || typeof args.thread !== 'string' || typeof args.id !== 'string') throw bad('text, thread and id are needed.');
      const r = hub.transport('routed');
      if (!(r instanceof Routed)) return { status: 404, body: { error: 'No such channel.' } };
      return r.take(args as RoutedIn);
    },
  });
  ctx.command({
    id: COMMANDS.rotate,
    run: async (args: { channel?: unknown }) => {
      const ch = typeof args.channel === 'string' ? hub.transport(args.channel) : undefined;
      if (!ch?.rotate) return { status: 404, body: { error: 'No such channel.' } };
      return ch.rotate();
    },
  });
  ctx.command({
    id: COMMANDS.extra,
    readOnly: true,
    run: async (args: { channel?: unknown; what?: unknown }): Promise<Json> => {
      const ch = typeof args.channel === 'string' ? hub.transport(args.channel) : undefined;
      if (!ch?.extra || typeof args.what !== 'string') throw Object.assign(bad('Not found.', 404), { code: 'not_found' });
      return ch.extra(args.what);
    },
  });
  ctx.command({ id: COMMANDS.refresh, run: () => (hub.start(), {}) });
}
