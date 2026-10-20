// Agent registry. To add a harness write an adapter with the same shape as ./claude.js
// (./common.js has the shared plumbing) and register it here:
//
//   {
//     id, name, models: [{id, label, hint?, efforts?}],
//     efforts?: string[]                           reasoning levels for every model (a model's own
//                                                  efforts list wins); omit if the CLI has none
//     askTool: string | null | undefined           how the agent sees wisp's ask_user MCP tool;
//                                                  null = can't inject MCP, ask via a question block
//     approveTool?: string                         its permission prompts go to wisp's `approve` MCP
//                                                  tool (live approval); omit if it can't route them
//     permission?(tool, input, cwd): { tool, action, detail, why? }   what a live approval is about
//     detect(): Promise<{ available, version?, error?, models? }>   models overrides the static list
//     resumeCommand({ resumeId, model, effort }): string[]   argv to continue the session interactively
//     run({ prompt, cwd, resumeId, mode, model, effort, systemPrompt, grants, onEvent }): { stop(), done: Promise }
//                                                  grants: `rule`s from its own blocked events the
//                                                  user allowed, for this turn only
//   }
//
// onEvent receives normalized events:
//   { type: 'session', id }                         agent-side session id (used to resume follow-ups)
//   { type: 'tool', kind, label, file?, detail?, id?, output? }   kind: read|edit|run|search|web|agent|plan|tool
//                                                  id: the harness's call id, for a later tool_output;
//                                                  output: what it returned, if it reports calls once run
//   { type: 'tool_output', id, text }               what a finished call returned (the transcript shows it)
//   { type: 'tool_error', name, text }
//   { type: 'text', text }                          assistant prose, the final answer included
//   { type: 'thinking' }
//   { type: 'change', file, op, edits: [{ before, after }] }
//   { type: 'blocked', tool, detail, rule? }        a call its permissions refused; rule: what allows
//                                                  exactly that on a retry (none: retry in Full auto)
//   { type: 'result', text, isError, stopped?, stats? }   exactly once, at the end
//
// mode is one of: plan (read-only), edits (auto-accept file edits), auto (no permission prompts).
// Agents without a system-prompt flag prepend `systemPrompt` to the first prompt (withProtocol).

import claude from './claude.js';
import codex from './codex.js';
import opencode from './opencode.js';
import cursor from './cursor.js';
import antigravity from './antigravity.js';
import grok from './grok.js';

// The shape above, checked when wisp starts: a missing piece fails loudly here, not mid-run.
function checked(a) {
  const missing = [
    typeof a.id !== 'string' && 'id',
    typeof a.name !== 'string' && 'name',
    !Array.isArray(a.models) && 'models',
    a.askTool !== null && a.askTool !== undefined && typeof a.askTool !== 'string' && 'askTool',
    a.approveTool !== undefined && (typeof a.approveTool !== 'string' || typeof a.permission !== 'function') && 'approveTool + permission()',
    typeof a.detect !== 'function' && 'detect()',
    typeof a.run !== 'function' && 'run()',
    a.resumeCommand !== undefined && typeof a.resumeCommand !== 'function' && 'resumeCommand()',
  ].filter(Boolean);
  if (missing.length) throw new Error(`adapter ${a.id || '?'}: missing or wrong ${missing.join(', ')}`);
  return a;
}

export const adapters = Object.fromEntries([claude, codex, opencode, cursor, antigravity, grok].map((a) => [a.id, checked(a)]));

const detected = new Map();

// fresh: detect again even where a hit is cached (Settings → Agents → Re-check), so a newly
// signed-in provider's models or an upgraded CLI show up without restarting wisp.
export async function listAgents({ fresh = false } = {}) {
  if (fresh) detected.clear();
  return Promise.all(
    Object.values(adapters).map(async (a) => {
      if (!detected.has(a.id)) detected.set(a.id, a.detect());
      const found = await detected.get(a.id);
      // Only a hit is cached: a CLI installed while wisp is running shows up on the next call.
      if (!found.available) detected.delete(a.id);
      // delegates: can lead a team of subagents (needs wisp's MCP server injected).
      return { id: a.id, name: a.name, models: a.models, efforts: a.efforts || [], delegates: a.askTool !== null, ...found };
    }),
  );
}
