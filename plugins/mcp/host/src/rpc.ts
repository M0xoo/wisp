// The JSON-RPC side of MCP, for both audiences: initialize, tools/list, tools/call and ping, with v1's
// answers, error codes and refusal words (mcp-ask.js for an agent, mcp-wisp.js for the user's editors).

import type { ToolContribution } from '@wisp-plugin/mcp-api';
import { type AgentEnv, approve, callAgentTool } from './agent-tools.ts';
import { type Who, notOffered, toolsFor } from './offer.ts';
import { type UserEnv, callUserTool } from './user-tools.ts';

export interface RpcCtx {
  who: Who;
  /** tools other plugins contributed (`mcp.tool@1`) */
  extra: readonly ToolContribution[];
  agent?: AgentEnv;
  user?: UserEnv;
  /** wisp's version, for `wisp mcp`'s serverInfo */
  version: string;
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; [k: string]: unknown };
}

export type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const INSTRUCTIONS = "wisp runs coding agents in the background. Launch with wisp_launch, then wisp_wait / wisp_get for the result; wisp_reply to follow up or answer a question. wisp_crew* manage the user's crew of long-lived agents.";
const CAPPED_WORDS = 'Refused: this task was started from a channel with a mode cap, so it can\'t use this. Say so in your report; the user can do it in wisp.';
const READ_ONLY_WORDS = 'Not available in a side discussion: it only reads and changes nothing.';

const text = (t: string, isError = false): unknown => ({ ...(isError && { isError: true }), content: [{ type: 'text', text: t }] });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Narrows anything that came off the wire to a message, or null when it isn't one. */
export function asMessage(v: unknown): RpcMessage | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as RpcMessage;
}

async function agentCall(c: RpcCtx, env: AgentEnv, name: string, args: Record<string, unknown>): Promise<unknown | undefined> {
  const why = notOffered(name, c.who.info, c.extra);
  if (why) return text(why === 'capped' ? CAPPED_WORDS : READ_ONLY_WORDS, true);
  try {
    if (name === 'approve') return env.info.approve ? text(JSON.stringify(await approve(env, args))) : undefined;
    const out = await callAgentTool(env, name, args, c.extra);
    return out === undefined ? undefined : text(out);
  } catch (err) {
    const what = name === 'ask_user' || name === 'approve' ? 'wisp could not reach the user' : 'wisp';
    // A permission prompt that errors would leave the harness guessing: deny, and say why.
    if (name === 'approve') return text(JSON.stringify({ behavior: 'deny', message: `${what}: ${message(err)}` }));
    return text(`${what}: ${message(err)}`, true);
  }
}

async function userCall(env: UserEnv, extra: readonly ToolContribution[], name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const own = extra.find((x) => x.tool.name === name && x.for !== 'agent');
    if (own) {
      const r = await env.run<{ text?: string; error?: string }>(own.command, args);
      if (r.error) throw new Error(r.error);
      return text(r.text ?? '');
    }
    return text(await callUserTool(env, name, args));
  } catch (err) {
    if ((err as { code?: unknown }).code === -32602) throw err;
    return text(`wisp: ${message(err)}`, true);
  }
}

/** One message in, its answer out; null for a notification (no id), which gets none. */
export async function handleRpc(raw: unknown, c: RpcCtx): Promise<RpcResponse | null> {
  const msg = asMessage(raw);
  if (!msg || msg.id === undefined) return null;
  const id = msg.id;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, m: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message: m } });
  const { method, params } = msg;
  if (method === 'initialize') {
    const protocolVersion = params?.protocolVersion || '2025-06-18';
    if (c.who.kind === 'agent') return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'wisp', version: '0.1.0' } });
    return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'wisp', version: c.version }, instructions: INSTRUCTIONS });
  }
  if (method === 'tools/list') return ok({ tools: toolsFor(c.who, c.extra) });
  if (method === 'ping') return ok({});
  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (c.who.kind === 'agent' && c.agent) {
      const out = await agentCall(c, c.agent, name, args);
      if (out !== undefined) return ok(out);
    } else if (c.user) {
      try {
        return ok(await userCall(c.user, c.extra, name, args));
      } catch (err) {
        return fail(-32602, message(err));
      }
    }
  }
  return fail(-32601, `Method not found: ${String(method)}`);
}

