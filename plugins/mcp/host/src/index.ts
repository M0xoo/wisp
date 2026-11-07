// wisp.mcp: wisp's MCP server, in-process. v1 ran it as a child of every harness (server/mcp-ask.js),
// talking to wisp over HTTP, and as `wisp mcp` for the user's editors (server/mcp-wisp.js). Here both
// are one JSON-RPC handler behind POST /api/mcp: the edge authenticates the token (a session's own, or
// the user's) and hands the caller in; each tool runs as a command of its owner under that caller, so
// the capability set (agent:session, agent:capped, user:full) decides, not which tools were listed.

import type { HttpRequestContext, HttpService, Json, PluginContext } from '@wisp/kernel';
import { AGENT_TOKENS, MCP_PATH, type McpSessionInfo, POINTS, type SessionFlags, type TeamEntry, type ToolContribution } from '@wisp-plugin/mcp-api';
import { EVENTS as RUNTIME_EVENTS, COMMANDS as RUNTIME, POINTS as RUNTIME_POINTS, type RunPart, type Session } from '@wisp-plugin/runtime-api';
import { type AgentEnv } from './agent-tools.ts';
import { BUILTIN_NAMES, toolsFor, whoOf } from './offer.ts';
import { type RpcCtx, type RpcResponse, handleRpc } from './rpc.ts';
import { Changes } from './waits.ts';

export { handleRpc } from './rpc.ts';
export type { RpcCtx, RpcMessage, RpcResponse } from './rpc.ts';
export { serveStdio, goneAnswer } from './stdio.ts';
export { toolsFor, whoOf, READ_ONLY_TOOLS, CAPPED_OFF } from './offer.ts';
export { USER_COMMANDS } from './user-tools.ts';
export { openapi } from './openapi.ts';

// @wisp/kernel's definePlugin, once its index exports one; the shape is the PluginDef contract.
const definePlugin = <T extends { id: string; setup(ctx: PluginContext): void | Promise<void> }>(d: T): T => d;

interface Caller {
  set: string;
  session?: string | undefined;
}

/** What the runtime's harness point says of a harness, the part this plugin reads. */
interface HarnessLike {
  id: string;
  askTool?: string | null;
  approveTool?: string;
}

const header = (h: HttpRequestContext['headers'], k: string): string => {
  const v = h[k];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

/** A team entry as the runtime hands it in, held to the shape `delegate` describes. */
const teamOf = (team: readonly Json[]): TeamEntry[] =>
  team.flatMap((m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
    const s = (k: string): string | undefined => (typeof m[k] === 'string' ? (m[k] as string) : undefined);
    const name = s('name');
    if (!name) return [];
    const copies = Array.isArray(m['copies']) ? m['copies'].filter((x): x is string => typeof x === 'string') : undefined;
    const e: TeamEntry = { name, agent: s('agent') ?? '', count: typeof m['count'] === 'number' ? m['count'] : 1 };
    for (const k of ['model', 'effort', 'use', 'place'] as const) {
      const v = s(k);
      if (v) e[k] = v;
    }
    if (copies?.length) e.copies = copies;
    return [e];
  });

export class McpServer {
  readonly #ctx: PluginContext;
  readonly changes: Changes;
  /** the flags of each session's current run (v1's env on the mcp-ask.js child), set when the run starts */
  readonly infos = new Map<string, McpSessionInfo>();
  readonly #chain = new Map<string, Promise<unknown>>();

  constructor(ctx: PluginContext) {
    this.#ctx = ctx;
    this.changes = new Changes({ timeout: (ms, fn) => this.#timeout(ms, fn) }, ctx.scope.signal);
  }

  #timeout(ms: number, fn: () => void): () => void {
    // A child scope per timer, so a wait that ends early frees its timer at once.
    const s = this.#ctx.scope.child('mcp-wait');
    s.timeout(ms, () => {
      s.dispose();
      fn();
    });
    return () => s.dispose();
  }

  /** What plugins say of a session, over the run's own flags. */
  flags(session: Pick<Session, 'id' | 'ext'>): McpSessionInfo {
    let out: McpSessionInfo = {};
    for (const f of this.#contributions<SessionFlags>(POINTS.session)) {
      try {
        out = { ...out, ...f.flags(session) };
      } catch (err) {
        this.#ctx.log.warn(`mcp: ${f.id} flags threw`, { error: String(err) });
      }
    }
    return out;
  }

  #contributions<T>(point: string): readonly T[] {
    try {
      return this.#ctx.contributions<T>(point);
    } catch {
      return [];
    }
  }

  extra(): ToolContribution[] {
    return this.#contributions<ToolContribution>(POINTS.tool).filter((c) => !BUILTIN_NAMES.has(c.tool.name));
  }

  /** `runtime.run@1`: wisp's own MCP server for a run, with its session's flags kept for its calls. */
  servers(session: Session, o: { mode: string; harness: string; team: Json[]; turnId: string; sub: boolean }): Record<string, Json> {
    // Subagents get only the connectors: they have nobody to ask (v1 runner #mcpServers).
    if (o.sub) return {};
    const harness = this.#contributions<HarnessLike>(RUNTIME_POINTS.harness).find((h) => h.id === o.harness);
    if (harness?.askTool === null) return {};
    const tokens = this.#ctx.tryUse(AGENT_TOKENS);
    if (!tokens) return {};
    const info: McpSessionInfo = { ...this.flags(session), approve: !!harness?.approveTool, team: teamOf(o.team), turnId: o.turnId };
    this.infos.set(session.id, info);
    const url = `${this.#ctx.service<HttpService>('http').url}/api${MCP_PATH}`;
    const token = tokens.sessionToken(session.id);
    // http for a harness that takes it; env for the edge's stdio bridge (`wisp mcp-ask`) where it doesn't.
    return { wisp: { type: 'http', url, headers: { authorization: `Bearer ${token}`, 'x-wisp-turn': o.turnId }, env: { WISP_URL: url, WISP_TOKEN: token, WISP_SESSION: session.id, WISP_TURN: o.turnId } } };
  }

  /** A session's flags: its run's, or worked out now when wisp restarted under a live run. */
  async infoOf(session: string, turn: string): Promise<McpSessionInfo> {
    let info = this.infos.get(session);
    if (!info) {
      const s = await this.#ctx.run<Session>(RUNTIME.get, { id: session }).catch(() => null);
      info = s ? this.flags(s) : {};
      this.infos.set(session, info);
    }
    return turn && turn !== info.turnId ? { ...info, turnId: turn } : info;
  }

  /** The context one message is answered in, for this caller. */
  async rpcCtx(caller: Caller, o: { cwd?: string; turn?: string; signal?: AbortSignal | undefined; run<R>(cmd: string, args: unknown): Promise<R> }): Promise<RpcCtx> {
    const info = caller.session ? await this.infoOf(caller.session, o.turn ?? '') : {};
    const who = whoOf(caller, info);
    const now = (): number => this.#ctx.clock.now();
    const base = { who, extra: this.extra(), version: this.#ctx.manifest.version };
    if (who.kind === 'user' || !caller.session) return { ...base, user: { run: o.run, changes: this.changes, now, cwd: o.cwd ?? '', signal: o.signal } };
    const agent: AgentEnv = { session: caller.session, info: who.info, run: o.run, changes: this.changes, now, signal: o.signal, chain: this.#chain };
    return { ...base, agent };
  }

  /** POST /api/mcp: one JSON-RPC message, as the caller the edge authenticated. */
  async http(req: HttpRequestContext): Promise<{ status: number; json: unknown } | { status: number; text: string }> {
    const ac = new AbortController();
    const raw = req.raw.req as { once?(ev: string, fn: () => void): void } | undefined;
    raw?.once?.('close', () => ac.abort());
    const caller = req.caller;
    const run = <R>(cmd: string, args: unknown): Promise<R> => this.#ctx.run<R>(cmd, args, { caller: { set: caller.set, ...(caller.session && { session: caller.session }) } });
    const c = await this.rpcCtx(caller, { cwd: header(req.headers, 'x-wisp-cwd'), turn: header(req.headers, 'x-wisp-turn'), signal: ac.signal, run });
    const out: RpcResponse | null = await handleRpc(await req.body(), c);
    return out ? { status: 200, json: out } : { status: 202, text: '' };
  }
}

type RpcArgs = { msg: unknown; cwd?: string; turn?: string };
const parseRpc = (a: unknown): RpcArgs => {
  const o = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
  return { msg: o['msg'], ...(typeof o['cwd'] === 'string' && { cwd: o['cwd'] }), ...(typeof o['turn'] === 'string' && { turn: o['turn'] }) };
};

export default definePlugin({
  id: 'wisp.mcp',
  setup(ctx: PluginContext) {
    const mcp = new McpServer(ctx);
    // Every wait re-checks when the runtime says something moved: no timer polls wisp.
    for (const e of [RUNTIME_EVENTS.changed, RUNTIME_EVENTS.finished, RUNTIME_EVENTS.ended, RUNTIME_EVENTS.asked, RUNTIME_EVENTS.deleted, RUNTIME_EVENTS.started]) ctx.on(e, () => mcp.changes.poke());
    ctx.on<{ id?: string }>(RUNTIME_EVENTS.deleted, (e) => {
      if (e.data.id) mcp.infos.delete(e.data.id);
    });
    ctx.scope.add(() => mcp.changes.poke());
    ctx.contribute<RunPart>(RUNTIME_POINTS.run, { id: 'wisp.mcp', mcpServers: (s, o) => mcp.servers(s, o) });
    ctx.command<RpcArgs, RpcResponse | null>({
      id: 'mcp.rpc',
      parse: parseRpc,
      run: async (a, call) => {
        const caller = call.trace.caller;
        const c = await mcp.rpcCtx(caller, { ...(a.cwd !== undefined && { cwd: a.cwd }), ...(a.turn !== undefined && { turn: a.turn }), signal: call.trace.signal, run: (cmd, args) => call.run(cmd, args) });
        return handleRpc(a.msg, c);
      },
    });
    ctx.command({
      id: 'mcp.tools',
      readOnly: true,
      run: async (_a: unknown, call) => {
        const caller = call.trace.caller;
        const info = caller.session ? await mcp.infoOf(caller.session, '') : {};
        return toolsFor(whoOf(caller, info), mcp.extra());
      },
    });
    ctx.service<HttpService>('http').route('POST', MCP_PATH, (req) => mcp.http(req), { permission: 'mcp:call', summary: 'One MCP JSON-RPC message (initialize, tools/list, tools/call, ping), as the caller the token speaks for' });
  },
});
