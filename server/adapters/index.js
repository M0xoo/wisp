// Agent registry. To add a harness write an adapter with the same shape as ./claude.js
// (./common.js has the shared plumbing) and register it here:
//
//   {
//     id, name, models: [{id, label, hint?, efforts?}],
//     efforts?: string[]                           reasoning levels for every model (a model's own
//                                                  efforts list wins); omit if the CLI has none
//     askTool: string | null | undefined           how the agent sees wisp's ask_user MCP tool;
//                                                  null = can't inject MCP, ask via a question block
//     detect(): Promise<{ available, version?, error?, models? }>   models overrides the static list
//     resumeCommand({ resumeId, model, effort }): string[]   argv to continue the session interactively
//     run({ prompt, cwd, resumeId, mode, model, effort, systemPrompt, onEvent }): { stop(), done: Promise }
//   }
//
// onEvent receives normalized events:
//   { type: 'session', id }                         agent-side session id (used to resume follow-ups)
//   { type: 'tool', kind, label, file?, detail? }   kind: read|edit|run|search|web|agent|plan|tool
//   { type: 'tool_error', name, text }
//   { type: 'text', text }                          intermediate assistant prose
//   { type: 'thinking' }
//   { type: 'change', file, op, edits: [{ before, after }] }
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

export const adapters = Object.fromEntries([claude, codex, opencode, cursor, antigravity, grok].map((a) => [a.id, a]));

const detected = new Map();

export async function listAgents() {
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
