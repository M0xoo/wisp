// wisp.connectors: MCP servers the user adds once in Settings, handed to every task's agent whatever
// the harness (v1 server/connectors.js, connector-auth.js, mcp-connector.js, routes/connectors.js).
// What a connector is lives in the store; its env values, headers and OAuth tokens live in the
// secrets service, and reach the server only through the proxy a harness starts by id, so a token
// never sits in a CLI's arguments, in the store, or in what the page or an agent sees.

import os from 'node:os';
import type { CallContext, Json, PluginContext, PluginDef, ProcService, SecretsService } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import { POINTS } from '@wisp-plugin/runtime-api';
import type { RunPart, Session } from '@wisp-plugin/runtime-api';
import { BRIDGE, COMMANDS, EVENTS } from '@wisp-plugin/connectors-api';
import type { ForTurnArgs } from '@wisp-plugin/connectors-api';
import { AgentTools, type Asker } from './agent.ts';
import { bad, type Body } from './model.ts';
import { registerRoutes } from './routes.ts';
import { Connectors } from './service.ts';
import { CONNECTOR, DISMISSED, MIGRATIONS, OWNER } from './store.ts';

// @wisp/kernel exports no definePlugin yet (its index is being built): the identity, typed.
const definePlugin = <T extends PluginDef>(d: T): T => d;

type NetFetch = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

const rec = (a: unknown): Body => (a && typeof a === 'object' && !Array.isArray(a) ? (a as Body) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function setupService(ctx: PluginContext): Connectors {
  const store = ctx.service<Store>('store');
  store.migrate(OWNER, MIGRATIONS);
  store.register(CONNECTOR);
  store.register(DISMISSED);
  const net = ctx.service<{ fetch: NetFetch }>('net');
  const paths = ctx.service<{ home: string }>('paths');
  return new Connectors({
    store,
    secrets: ctx.service<SecretsService>('secrets'),
    fetch: (url, init) => net.fetch(url, init),
    proc: ctx.service<ProcService>('proc'),
    now: () => ctx.clock.now(),
    scope: ctx.scope,
    version: ctx.manifest.version,
    where: { home: os.homedir(), env: process.env },
    home: paths.home,
    env: process.env,
    emit: (type, data) => ctx.emit(type, data),
    bridge: () => ctx.tryUse(BRIDGE),
    // Without the edge's bridge: the bin that is running wisp, `wisp connector <id>`.
    launcher: { command: process.execPath, args: [process.argv[1] ?? 'wisp', 'connector'] },
  });
}

/** Who is asking, for the agent's tools: the session its token speaks for. */
async function asker(call: CallContext): Promise<Asker> {
  const id = call.trace.caller.session;
  if (!id) throw bad('no such session', 404);
  const s = await call.run<Session | null>('runtime.get', { id }).catch(() => null);
  if (!s) throw bad('no such session', 404);
  return { agent: s.agent, delegated: !!s.parentId || !!s.ext?.['wisp.crew'] };
}

function registerCommands(ctx: PluginContext, svc: Connectors): void {
  const tools = new AgentTools(svc);
  const changed = (): void => ctx.emit(EVENTS.changed, {});
  // In the background: the row shows Checking… until it answers.
  const testLater = (id: string): void => void ctx.run(COMMANDS.test, { id }).catch(() => undefined);
  const view = async (): Promise<Json> => (await svc.view()) as unknown as Json;

  ctx.command({ id: COMMANDS.list, permission: 'connectors:list', readOnly: true, run: () => view() });
  ctx.command({
    id: COMMANDS.add,
    permission: 'connectors:add',
    run: async (a: unknown) => {
      const c = await svc.add(rec(a));
      changed();
      testLater(c.id);
      return view();
    },
  });
  ctx.command({
    id: COMMANDS.update,
    permission: 'connectors:update',
    run: async (a: unknown) => {
      const { id, ...body } = rec(a);
      const { connector, edited } = await svc.update(id, body);
      changed();
      if (edited) testLater(connector.id);
      return view();
    },
  });
  ctx.command({
    id: COMMANDS.remove,
    permission: 'connectors:remove',
    run: async (a: unknown) => {
      await svc.remove(rec(a)['id']);
      changed();
      return view();
    },
  });
  ctx.command({
    id: COMMANDS.test,
    permission: 'connectors:test',
    run: async (a: unknown) => {
      await svc.test(svc.must(rec(a)['id']).id);
      return view();
    },
  });
  ctx.command({
    id: COMMANDS.import,
    permission: 'connectors:import',
    run: async (a: unknown) => {
      const b = rec(a);
      // dismiss: hide those names from the list until new ones appear.
      const { added, skipped } = await svc.import(strs(b['names']), strs(b['dismiss']));
      changed();
      const out = { ...(await svc.view()), skipped };
      for (const x of added) testLater(x.id);
      return out as unknown as Json;
    },
  });
  registerSignin(ctx, svc, changed, testLater, view);
  registerProxy(ctx, svc);
  registerAgent(ctx, svc, tools, changed);
}

function registerSignin(ctx: PluginContext, svc: Connectors, changed: () => void, testLater: (id: string) => void, view: () => Promise<Json>): void {
  ctx.command({
    id: COMMANDS.signin,
    permission: 'connectors:signin',
    run: async (a: unknown) => {
      const b = rec(a);
      const x = svc.must(b['id']);
      let redirect: string;
      try {
        redirect = new URL('/api/connectors/oauth/callback', String(b['origin'] || '')).href;
      } catch {
        throw bad('origin: the page’s own address, where the browser comes back to');
      }
      return { url: await svc.auth.start(x, redirect) };
    },
  });
  ctx.command({
    id: COMMANDS.signout,
    permission: 'connectors:signout',
    run: async (a: unknown) => {
      const x = svc.must(rec(a)['id']);
      await svc.auth.signOut(x);
      delete x.test;
      svc.save(x);
      changed();
      return view();
    },
  });
  ctx.command({
    id: COMMANDS.oauthFinish,
    permission: 'connectors:oauthFinish',
    run: async (a: unknown) => {
      const q = Object.fromEntries(Object.entries(rec(rec(a)['query'])).map(([k, v]) => [k, String(v)]));
      const x = await svc.auth.finish(q);
      changed();
      // Checked again with its new token.
      testLater(x.id);
      return { name: x.name };
    },
  });
}

function registerProxy(ctx: PluginContext, svc: Connectors): void {
  ctx.command({
    id: COMMANDS.token,
    permission: 'connectors:token',
    run: async (a: unknown) => {
      const b = rec(a);
      return { token: await svc.auth.token(svc.must(b['id']), { force: !!b['force'] }) };
    },
  });
  ctx.command({ id: COMMANDS.spec, permission: 'connectors:spec', readOnly: true, run: async (a: unknown) => (await svc.spec(svc.must(rec(a)['id']))) as unknown as Json });
  ctx.command({
    id: COMMANDS.forTurn,
    permission: 'connectors:forTurn',
    readOnly: true,
    run: async (a: unknown) => {
      const b = rec(a) as Partial<ForTurnArgs>;
      const cwd = typeof b.cwd === 'string' ? b.cwd : null;
      await svc.refreshOwn(cwd);
      return svc.turnServers(String(b.agent ?? ''), String(b.mode ?? ''), cwd);
    },
  });
  // Every run asks for its MCP servers through runtime.run@1: from memory, no I/O on the runner's path.
  const part: RunPart = { id: 'wisp.connectors', mcpServers: (s, o) => svc.turnServers(o.harness, o.mode, s.cwd) };
  ctx.contribute(POINTS.run, part);
  // A task's folder is read ahead of its first turn, so its own .mcp.json is known by then.
  ctx.on<{ session?: { cwd?: string } }>('session.created', (e) => {
    const cwd = e.data.session?.cwd;
    if (cwd) void svc.refreshOwn(cwd);
  });
}

function registerAgent(ctx: PluginContext, svc: Connectors, tools: AgentTools, changed: () => void): void {
  ctx.command({ id: COMMANDS.agentList, permission: 'connectors:agent.list', readOnly: true, run: async (_a: unknown, call) => (await asker(call), tools.list()) });
  ctx.command({
    id: COMMANDS.agentAdd,
    permission: 'connectors:agent.add',
    run: async (a: unknown, call) => {
      const s = await asker(call);
      const { connector } = tools.add(s, rec(a));
      changed();
      ctx.emit(EVENTS.agentAdded, { agent: s.agent, transport: connector.transport });
      // With keys still to fill in, a check would only fail.
      if (!svc.missing(connector).length) await svc.test(connector.id).catch(() => undefined);
      return tools.added(svc.find(connector.id) ?? connector);
    },
  });
  ctx.command({ id: COMMANDS.agentSignin, permission: 'connectors:agent.signin', readOnly: true, run: async (a: unknown, call) => tools.signin(await asker(call), rec(a)) as unknown as Json });
}

export default definePlugin({
  id: 'wisp.connectors',
  async setup(ctx: PluginContext) {
    const svc = setupService(ctx);
    await svc.init();
    registerCommands(ctx, svc);
    for (const d of registerRoutes(ctx)) ctx.scope.add(d);
  },
});

export { openapi } from './openapi.ts';
