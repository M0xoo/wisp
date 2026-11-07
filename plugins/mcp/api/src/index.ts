// @wisp-plugin/mcp-api: the contract of wisp.mcp, wisp's MCP server. Two audiences, one handler:
// every task's agent (v1 server/mcp-ask.js: ask_user, delegate, wisp_save, …, by its session's token)
// and the user's own editors (v1 server/mcp-wisp.js, `wisp mcp`). The edge authenticates the call and
// hands its caller in; wisp.mcp picks the tool list by that caller and runs each tool as a command of
// the tool's owner, under the caller's capability set, so a refusal is the kernel's, not a hidden tool.
//
// The tools' names, descriptions and schemas are a contract with every live prompt (plan §6.9): they are
// v1's, word for word, with goldens of v1's own tools/list output (plugins/mcp/host/test/goldens).

import type { Json, ServiceRef } from '@wisp/kernel';

// ---------- who is calling ----------

/** A member of the team a task may delegate to, as the runtime hands it in (v1 WISP_TEAM). */
export interface TeamEntry {
  name: string;
  /** the harness's name, or a crew member's description ("Ada of the user's crew, CI watcher") */
  agent: string;
  model?: string;
  effort?: string;
  use?: string;
  count: number;
  /** names of the parallel copies, when count > 1 ("x#1", "x#2") */
  copies?: string[];
  /** where it runs, when not here ("devbox", "another machine") */
  place?: string;
}

/**
 * What changes an agent's tool list, per session (v1's env flags on the mcp-ask.js child). wisp.mcp
 * fills it from the run (`runtime.run@1`) and from what plugins contribute into `mcp.session@1`.
 */
export interface McpSessionInfo {
  /** a side discussion (v1 WISP_READONLY): only the tools that read, ask or show, and approve */
  readOnly?: boolean;
  /** started from a channel at a mode cap (v1 WISP_CAPPED); also true for an `agent:capped…` caller */
  capped?: boolean;
  /** a Cast a spell task (v1 WISP_SPELLS): the spell-writing tools */
  spells?: boolean;
  /** the harness takes a permission-prompt tool (v1 WISP_APPROVE): `approve` */
  approve?: boolean;
  /** the watch page is on (v1 WISP_WATCH): `wisp_watch` */
  watch?: boolean;
  /** the team `delegate` describes (v1 WISP_TEAM) */
  team?: TeamEntry[];
  /** the turn this run belongs to (v1 WISP_TURN): a leftover helper can tell its turn is over */
  turnId?: string;
}

/** `mcp.session@1`: a plugin says what it knows about a session's tools (side: readOnly, spells: spells, watch: watch). */
export interface SessionFlags {
  id: string;
  flags(session: { id: string; ext: Record<string, Json> }): Partial<Omit<McpSessionInfo, 'team' | 'turnId'>>;
}

// ---------- the agent-facing commands each tool runs ----------

/**
 * Every agent tool is one command of its owner, the port of v1's /api/internal/* route behind it.
 * Args are the tool's arguments plus `session` (the asking task, from the caller) and, where v1 sent
 * one, `turn`; the answer is v1's route body: `{ text }`, or `{ error }` for a refusal the agent acts on.
 * The caller's capability set is checked against the command's permission before it runs.
 */
export interface AgentToolArgs {
  session: string;
  [k: string]: unknown;
}
export interface AgentToolResult {
  text?: string;
  error?: string;
  [k: string]: unknown;
}

/** tool → the owner's command (v1 route in the comment). Owners: register these ids. */
export const TOOL_COMMANDS = {
  resume_later: 'later.agent.schedule', // POST /internal/later
  wisp_tag: 'runtime.agent.tag', // POST /internal/tags
  wisp_pr: 'ship.agent.pr', // POST /internal/prs
  wisp_watch: 'watch.agent.apply', // POST /internal/watch
  wisp_save: 'stuff.agent.save', // POST /internal/stuff
  wisp_stuff: 'stuff.agent.list', // GET /internal/stuff/:id  (id, query, kind, limit)
  wisp_stats: 'runtime.agent.stats', // GET /internal/stats/:id
  wisp_sessions: 'runtime.agent.sessions', // GET /internal/sessions/:id
  wisp_session: 'runtime.agent.session', // GET /internal/session/:id  (of, turn)
  wisp_blocks: 'runtime.agent.blocks', // v1 answered in the MCP server: protocol.js blockDocs(types)
  wisp_crew: 'crew.agent.list', // GET /internal/crew/:id  (member?)
  wisp_crew_add: 'crew.agent.add', // POST /internal/crew/:id
  wisp_crew_edit: 'crew.agent.edit', // PATCH /internal/crew/:id
  wisp_crew_kit: 'crew.agent.kit', // POST /internal/crew/:id/kit
  wisp_crew_remove: 'crew.agent.remove', // DELETE /internal/crew/:id
  wisp_connectors: 'connectors.list', // GET /internal/connectors/:id
  wisp_connector_add: 'connectors.add', // POST /internal/connectors/:id  (+ transport)
  wisp_connector_signin: 'connectors.signin', // POST /internal/connectors/:id/signin → { text } | { id: askId }
  wisp_spells: 'plugins.agent.spells', // GET /internal/spells/:id
  wisp_spell_schema: 'plugins.agent.spellSchema', // GET /internal/spell-schema/:id
  wisp_spell_data: 'plugins.agent.spellData', // POST /internal/spell-data/:id
  wisp_spell_check: 'plugins.agent.spellCheck', // POST /internal/spell-check/:id
  wisp_available: 'runtime.agent.available', // GET /internal/available/:id
  wisp_launch: 'runtime.agent.launch', // POST /internal/launch/:id → { text, ids }
  wisp_task: 'runtime.agent.task', // POST /internal/task/:id
  wisp_task_state: 'runtime.agent.taskState', // GET /internal/task/:id?of= → { settled, question, text }
} as const;

// ---------- this plugin's own commands ----------

export const COMMANDS = {
  /** one JSON-RPC message in, its answer out (null for a notification); what POST /mcp runs */
  rpc: 'mcp.rpc', // { msg, cwd? } → JSON-RPC response | null
  /** the tools a caller is offered (read-only) */
  tools: 'mcp.tools', // { info? } → Tool[]
} as const;

// ---------- points ----------

/** A tool's definition as MCP lists it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

/**
 * `mcp.tool@1`: a plugin adds a tool of its own (built-ins get no private API: v1's tools are wisp.mcp's,
 * and anything a user's plugin adds goes after them). `run` is called with the caller's call context.
 */
export interface ToolContribution {
  tool: McpTool;
  /** who is offered it */
  for: 'agent' | 'user' | 'both';
  /** offered in a side discussion (it only reads, asks or shows) */
  readOnly?: boolean;
  /** hidden from a task a channel started at a mode cap (a courtesy: the capability set refuses anyway) */
  cappedOff?: boolean;
  /** the command that answers it: args are the tool's plus `session`; the answer `{ text }` or `{ error }` */
  command: string;
}

export const POINTS = {
  tool: 'mcp.tool', // ToolContribution, version 1
  session: 'mcp.session', // SessionFlags, version 1
} as const;

// ---------- the edge's side ----------

/** Who an agent is: the edge's per-session tokens (v1 agent-token.js). wisp.mcp puts one in each run's MCP config. */
export interface AgentTokens {
  /** the token that speaks for this session only */
  sessionToken(sessionId: string): string;
}
export const AGENT_TOKENS: ServiceRef<AgentTokens> = { id: 'agent.tokens', major: 1, permissions: { sessionToken: 'agent:token' } };

/** The MCP route: POST /api/mcp, one JSON-RPC message per request (Streamable HTTP without the stream). */
export const MCP_PATH = '/mcp';
