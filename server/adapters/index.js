// Agent registry. To add a harness (codex, opencode, …) write an adapter with the
// same shape as ./claude.js and register it here:
//
//   {
//     id, name, models: [{id, label}],
//     detect(): Promise<{ available, version?, error? }>,
//     resumeCommand({ resumeId, model }): string[]   argv to continue the session interactively
//     run({ prompt, cwd, resumeId, mode, model, systemPrompt, onEvent }): { stop(), done: Promise }
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
// Agents without a system-prompt flag can prepend `systemPrompt` to the first prompt instead.

import claude from './claude.js';

export const adapters = { [claude.id]: claude };

const detected = new Map();

export async function listAgents() {
  return Promise.all(
    Object.values(adapters).map(async (a) => {
      if (!detected.has(a.id)) detected.set(a.id, a.detect());
      return { id: a.id, name: a.name, models: a.models, ...(await detected.get(a.id)) };
    }),
  );
}
