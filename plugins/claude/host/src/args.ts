// The command line and environment of one `claude -p` run (v1 adapters/claude.js run()), pure: what
// the CLI is (its version) and whether Chrome is on are read before and passed in.

import { attachmentNote, ASK_TIMEOUT_MS, onDisk } from '@wisp/harness-kit';
import type { HarnessRun, Mode } from '@wisp-plugin/runtime-api';
import { SUBAGENT_MODELS } from './usage.ts';
import path from 'node:path';

/**
 * A lean run (the retro) only reads its prompt and answers: its own system prompt instead of Claude
 * Code's, no tools, MCP servers, skills or saved session. A real retro went from 28k input tokens
 * to 3k with the same reply. Claude Code 2.1 has all of these flags. --setting-sources user: nor
 * the folder's hooks (project trust).
 */
const LEAN = ['--tools', '', '--strict-mcp-config', '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence'];
/**
 * A run in a repo you haven't trusted: only your own settings, so not the repo's hooks
 * (.claude/settings.json, settings.local.json: a repo can commit that one too), and only the MCP
 * servers wisp passes, so not .mcp.json's (nor, this run, your own).
 */
const UNTRUSTED = ['--setting-sources', 'user', '--strict-mcp-config'];
/** what a gated run always asks wisp about */
const GATED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'];

export const PERMISSION_MODES: Readonly<Record<Mode, string>> = { plan: 'plan', edits: 'acceptEdits', auto: 'bypassPermissions' };

/** Inherited from a parent Claude Code session (wisp itself run from one): never leaks into the child (v1 pty.js). */
export const PARENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID'];
/** Settings that make Claude Code spend extra model calls on wisp's behalf (progress summaries of its subagents). */
export const COSTLY_ENV = ['CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES'];
/** Without Claude Code's nonessential traffic (v1 lean.js), which also drops claude.ai connectors. */
export const LEAN_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

export const APPROVE_TOOL = 'mcp__wisp__approve';

/** [major, minor, patch]: Claude Code 2.1 has every lean flag. */
export const leanOk = (version: readonly number[]): boolean => version.length === 3 && ((version[0] ?? 0) > 2 || (version[0] === 2 && (version[1] ?? 0) >= 1));

export interface ClaudeArgs {
  args: string[];
  input: string;
  env: Record<string, string | undefined>;
  lean: boolean;
}

export function claudeArgs(o: HarnessRun, what: { version: readonly number[]; chrome: boolean; baseEnv: Record<string, string | undefined> }): ClaudeArgs {
  const lean = !!o.lean && leanOk(what.version);
  const gate = !!o.gate;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    lean ? '--system-prompt' : '--append-system-prompt', o.systemPrompt,
    // acceptEdits never reaches the approve tool (nor does rm or touch): only default does.
    '--permission-mode', gate ? 'default' : PERMISSION_MODES[o.mode] || 'acceptEdits',
  ];
  // An ask rule beats allow rules, so the user's own settings can't take a write past the gate.
  if (gate) args.push('--settings', JSON.stringify({ permissions: { ask: GATED } }));
  if (lean) args.push(...LEAN);
  else if (o.untrusted) args.push(...UNTRUSTED);
  // Not on a /compact: with that flag it answers "isn't available in this environment" (claude 2.1.316).
  if (o.skills === 'off' && !lean && !/^\/compact(\s|$)/.test(String(o.prompt).trim())) args.push('--disable-slash-commands');
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (what.chrome) args.push('--chrome');
  if (o.resumeId) args.push('--resume', o.resumeId);
  if (o.resumeId && o.fork) args.push('--fork-session', '--no-session-persistence');
  const servers = o.mcpServers ?? {};
  if (Object.keys(servers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
  // In Edits mode, what would prompt goes to wisp's approve tool (the user decides) instead of being denied.
  if (servers['wisp'] && o.mode === 'edits') args.push('--permission-prompt-tool', APPROVE_TOOL);
  const allowed = [...Object.keys(servers).map((n) => `mcp__${n}`), ...(o.grants ?? []).filter((g) => typeof g === 'string')];
  if (allowed.length) args.push('--allowedTools', ...allowed);
  // Its built-in subagents (Task, or Agent in newer versions) would bypass the user's team.
  if (o.delegating) args.push('--disallowedTools', 'Task', 'Agent', 'Workflow');
  const files = onDisk(o.attachments ?? []);
  const dirs = [...new Set([...(o.dirs ?? []), ...files.map((a) => path.dirname(a.path))])];
  if (dirs.length) args.push('--add-dir', ...dirs);
  args.push('--verbose'); // terminates the variadic flags above
  const input = o.prompt + attachmentNote(files, 'Read images and PDFs with the Read tool');

  const env: Record<string, string | undefined> = { ...what.baseEnv, ...o.accountEnv, ...o.env };
  for (const k of PARENT_SESSION_ENV) delete env[k]; // don't let a parent Claude Code session leak into the child
  for (const k of COSTLY_ENV) delete env[k];
  if (o.quiet) Object.assign(env, LEAN_ENV);
  // Never _FORCE: an Agent call's own model, or a custom agent's, still wins.
  const sub = o.subagentModel ?? '';
  if (sub && (SUBAGENT_MODELS as readonly string[]).includes(sub)) env['CLAUDE_CODE_SUBAGENT_MODEL'] = env['CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL'] = sub;
  env['MCP_TOOL_TIMEOUT'] ??= String(ASK_TIMEOUT_MS);
  return { args, input, env, lean };
}

/**
 * Interactive command to take over a session in a terminal, or (terminal sessions) to start one with
 * its first prompt: sessionId names the new conversation, so wisp can resume it later. The prompt
 * goes after `--`: --add-dir takes every word after it.
 */
export function resumeArgv(bin: string, o: { resumeId?: string; sessionId?: string; model: string; effort: string; dirs?: string[]; mode?: Mode; systemPrompt?: string; prompt?: string }): string[] {
  return [
    bin,
    ...(o.resumeId ? ['--resume', o.resumeId] : o.sessionId ? ['--session-id', o.sessionId] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.mode && PERMISSION_MODES[o.mode] ? ['--permission-mode', PERMISSION_MODES[o.mode]] : []),
    ...(o.systemPrompt ? ['--append-system-prompt', o.systemPrompt] : []),
    ...(o.dirs ?? []).flatMap((d) => ['--add-dir', d]),
    ...(o.prompt ? ['--', o.prompt] : []),
  ];
}
