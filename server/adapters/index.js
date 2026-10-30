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
//     fork?: true                                  run({ resumeId, fork: true }) works on a copy of
//                                                  that conversation, leaving it as it is (/btw)
//     permission?(tool, input, cwd): { tool, action, detail, why? }   what a live approval is about
//     detect(): Promise<{ available, version?, error?, models? }>   models overrides the static list
//     setup?(platform): { tip, command?, url? }    how to get it on that OS, sent while it isn't found
//     resumeCommand({ resumeId, model, effort, cwd, trusted, prompt, sessionId?, mode?, systemPrompt? }): string[]
//                                                  argv to continue the session interactively, or with
//                                                  no resumeId to start one on prompt (terminal sessions;
//                                                  typesPrompt: true when it can't, and wisp types it in);
//                                                  trusted: cwd is a folder wisp made (scratch, worktree),
//                                                  start without asking to trust it
//     trust?(dir)                                  record dir as trusted in the CLI's own config, for
//                                                  one whose trust question no flag skips
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
//   { type: 'limits', windows: [{ id, used, resetsAt, ms }], rejected? }   how much of the account's
//                                                  usage windows is gone (server/budget.js); before result
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
import copilot from './copilot.js';
import { signedIn } from '../agent-login.js';

// The shape above, checked when wisp starts: a missing piece fails loudly here, not mid-run.
function checked(a) {
  const missing = [
    typeof a.id !== 'string' && 'id',
    typeof a.name !== 'string' && 'name',
    !Array.isArray(a.models) && 'models',
    a.askTool !== null && a.askTool !== undefined && typeof a.askTool !== 'string' && 'askTool',
    a.approveTool !== undefined && (typeof a.approveTool !== 'string' || typeof a.permission !== 'function') && 'approveTool + permission()',
    typeof a.detect !== 'function' && 'detect()',
    a.setup !== undefined && typeof a.setup !== 'function' && 'setup()',
    typeof a.run !== 'function' && 'run()',
    a.resumeCommand !== undefined && typeof a.resumeCommand !== 'function' && 'resumeCommand()',
    a.trust !== undefined && typeof a.trust !== 'function' && 'trust()',
  ].filter(Boolean);
  if (missing.length) throw new Error(`adapter ${a.id || '?'}: missing or wrong ${missing.join(', ')}`);
  return a;
}


export const adapters = Object.fromEntries([claude, codex, opencode, cursor, antigravity, grok, copilot].map((a) => [a.id, checked(a)]));

const detected = new Map();

// fresh: detect again even where a hit is cached (Settings → Agents → Re-check), so a newly
// signed-in provider's models or an upgraded CLI show up without restarting wisp. fresh: '<id>'
// detects only that harness again (just signed in to it): the others answer from the cache.
export async function listAgents({ fresh = false } = {}) {
  if (typeof fresh === 'string') detected.delete(fresh); // not a harness (gh): nothing to redo
  else if (fresh) detected.clear();
  return Promise.all(
    Object.values(adapters).map(async (a) => {
      // Installed but signed out (it says so, and no API key signs it in): not available, so the
      // model picker only offers what you can use. Settings → Agents signs it in.
      if (!detected.has(a.id))
        detected.set(
          a.id,
          a.detect().then(async (f) => (f.available && (await signedIn(a.id).catch(() => null)) === false ? { ...f, available: false, signedIn: false, error: 'Not signed in' } : f)),
        );
      const found = await detected.get(a.id);
      // Only a hit is cached: a CLI installed while wisp is running shows up on the next call. A
      // signed-out one stays cached too; signing in from wisp detects again.
      if (!found.available && found.signedIn !== false) detected.delete(a.id);
      // delegates: can lead a team of subagents (needs wisp's MCP server injected).
      return { id: a.id, name: a.name, models: a.models, efforts: a.efforts || [], delegates: a.askTool !== null, ...found, ...(!found.available && found.signedIn !== false && a.setup && { setup: a.setup() }) };
    }),
  );
}
