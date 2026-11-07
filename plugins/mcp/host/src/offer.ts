// Which tools a caller is offered, in v1's order (mcp-ask.js tools/list and mcp-wisp.js TOOLS). An agent's
// list depends on its session (McpSessionInfo, v1's env flags); the user's editors get `wisp mcp`'s.
// Hiding a tool proves nothing: the caller's capability set refuses the command behind it anyway.

import type { McpSessionInfo, ToolContribution } from '@wisp-plugin/mcp-api';
import { APPROVE, BLOCKS, LATER, PR, SAVE, SESSION, SESSIONS, STATS, STUFF, TAG, TOOL, WATCH } from './defs-agent.ts';
import { CREW_TOOLS } from './defs-crew.ts';
import { CONNECTOR_TOOLS, CONTROL_TOOLS, SPELL_TOOLS, teamTools } from './defs-more.ts';
import { USER_TOOLS } from './defs-user.ts';
import type { Tool } from './tool.ts';

// A side discussion's tools (v1 server/side.js): reading, asking you, the page beside the task, the
// gate. Nothing that starts tasks or edits your setup.
export const READ_ONLY_TOOLS: readonly string[] = ['approve', 'ask_user', 'resume_later', 'wisp_tag', 'wisp_watch', 'wisp_blocks', 'wisp_stats', 'wisp_sessions', 'wisp_session', 'wisp_stuff', 'wisp_crew', 'wisp_connectors', 'wisp_available'];
// What a task a channel started at a mode cap isn't offered: the tools that only change or read your setup.
export const CAPPED_OFF: readonly string[] = ['wisp_crew_add', 'wisp_crew_edit', 'wisp_crew_kit', 'wisp_crew_remove', 'wisp_connectors', 'wisp_connector_add', 'wisp_connector_signin'];

/** Who is calling, as the tools see it. */
export interface Who {
  /** 'agent': a task's agent (its session's token); 'user': the user's own editor (`wisp mcp`) */
  kind: 'agent' | 'user';
  info: McpSessionInfo;
}

/** An agent's session is capped by its info or by the set it speaks for. */
export const whoOf = (caller: { set: string; session?: string | undefined }, info: McpSessionInfo): Who => {
  if (!caller.session) return { kind: 'user', info: {} };
  return { kind: 'agent', info: caller.set.startsWith('agent:capped') ? { ...info, capped: true } : info };
};

const hinted = (t: Tool): Tool => (READ_ONLY_TOOLS.includes(t.name) ? { ...t, annotations: { readOnlyHint: true } } : t);

/** Why an agent isn't offered a tool by name, or '' when it is. */
export function notOffered(name: string, info: McpSessionInfo, extra: readonly ToolContribution[] = []): '' | 'capped' | 'readOnly' {
  const own = extra.find((c) => c.tool.name === name);
  if (info.capped && (own ? !!own.cappedOff : CAPPED_OFF.includes(name))) return 'capped';
  if (info.readOnly && !(own ? !!own.readOnly : READ_ONLY_TOOLS.includes(name))) return 'readOnly';
  return '';
}

// The full list before the filters, cached per shape: tools/list runs on every turn of every task.
const AGENT_BASE = [TOOL, LATER, TAG, PR];
const AGENT_MID = [SAVE, STUFF, BLOCKS, STATS, SESSIONS, SESSION, ...CREW_TOOLS, ...CONNECTOR_TOOLS, ...CONTROL_TOOLS];
const cache = new Map<string, readonly Tool[]>();

function agentTools(info: McpSessionInfo): readonly Tool[] {
  const key = `${info.watch ? 1 : 0}${info.approve ? 1 : 0}${info.spells ? 1 : 0}${info.readOnly ? 1 : 0}${info.capped ? 1 : 0}`;
  const team = info.team ?? [];
  const hit = !team.length && cache.get(key);
  if (hit) return hit;
  const all = [...AGENT_BASE, ...(info.watch ? [WATCH] : []), ...AGENT_MID, ...(info.approve ? [APPROVE] : []), ...teamTools(team), ...(info.spells ? SPELL_TOOLS : [])];
  const out = all.filter((t) => !notOffered(t.name, info)).map(hinted);
  if (!team.length) cache.set(key, out);
  return out;
}

/** The tools/list answer for this caller, built-ins first, then what plugins contributed. */
export function toolsFor(who: Who, extra: readonly ToolContribution[] = []): Tool[] {
  const own = extra.filter((c) => c.for === 'both' || c.for === who.kind);
  if (who.kind === 'user') return [...USER_TOOLS, ...own.map((c) => c.tool)];
  const added = own.filter((c) => !notOffered(c.tool.name, who.info, extra)).map((c) => (c.readOnly ? { ...c.tool, annotations: { ...c.tool.annotations, readOnlyHint: true } } : c.tool));
  return [...agentTools(who.info), ...added];
}

/** A built-in tool name of either list (a contribution can't take one). */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set([...agentTools({ watch: true, approve: true, spells: true }), ...teamTools([]), ...USER_TOOLS].map((t) => t.name));
