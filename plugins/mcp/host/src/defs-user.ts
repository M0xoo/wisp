// `wisp mcp`: the tools for the user's own agents and editors (Claude Code, Cursor, Zed, …), copied
// word for word from v1 server/mcp-wisp.js.

import { CREW_TOOLS } from './defs-crew.ts';
import type { Tool } from './tool.ts';

const AGENTS = ['auto', 'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok', 'copilot'];
export const DEFAULT_WAIT_S = 240; // stay under typical MCP client tool-call timeouts; call wisp_wait again for more

export const USER_TOOLS: Tool[] = [
  {
    name: 'wisp_launch',
    description:
      'Hand a coding task to a background agent in wisp. The agent works autonomously in the given folder and ends with a ' +
      'presentation (summary, diffs, test results). Returns the session id at once; pass wait=true to block until it finishes ' +
      'or asks a question. Use for independent, well-scoped tasks that can run in parallel with your own work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, written as you would brief a colleague: goal, constraints, how to verify.' },
        cwd: { type: 'string', description: 'Absolute path of the project folder. Default: this MCP server’s working directory.' },
        also: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of more folders the same agent works in (e.g. the API next to its web app). Git repos each get a worktree, and Ship it opens a PR in each.' },
        agent: { type: 'string', enum: AGENTS, description: 'Harness to run; auto lets wisp pick harness and model from what worked before. Default: the user’s last pick in wisp.' },
        mode: { type: 'string', enum: ['plan', 'edits', 'auto'], description: 'plan = read-only, edits = auto-accept file edits, auto = no permission prompts. Default: the user’s pick.' },
        model: { type: 'string', description: 'Model id for that harness. Default: the user’s pick.' },
        effort: { type: 'string', description: 'Thinking level, e.g. low | medium | high.' },
        subagents: {
          type: 'array',
          description: 'A team the agent can delegate to, each on its own harness: [{ agent, model?, effort?, name?, use?, count? }]. use = when to pick it ("research", "image work"); count = parallel copies (1–5).',
          items: { type: 'object', properties: { agent: { type: 'string', enum: AGENTS }, model: { type: 'string' }, effort: { type: 'string' }, name: { type: 'string' }, use: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 5 }, machine: { type: 'string', description: 'Run this subagent on a machine (id from wisp_agents).' } }, required: ['agent'] },
        },
        preset: { type: 'string', description: 'Id of a saved subagent preset, instead of subagents.' },
        machine: { type: 'string', description: 'Run it on one of the user’s machines (id from wisp_agents). cwd is then the folder there, or a project folder here that wisp finds or clones there. Default: this computer.' },
        wait: { type: 'boolean', description: 'Block until the agent finishes or asks (up to timeout_seconds).' },
        timeout_seconds: { type: 'number', description: `Max wait when wait=true. Default ${DEFAULT_WAIT_S}.` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'wisp_list',
    description: 'List wisp sessions, newest first, with state (running | waiting | review | done) and a one-line summary.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Comma-separated filter, e.g. "running,waiting".' },
        cwd: { type: 'string', description: 'Only sessions in this folder (or below).' },
        limit: { type: 'number', description: 'Default 20.' },
      },
    },
  },
  {
    name: 'wisp_get',
    description: 'Read a session: its state and the latest presentation as markdown (diffs, tests, next steps), plus any question the agent is waiting on.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'wisp_wait',
    description: 'Block until a session finishes or asks a question, then return it like wisp_get. Returns early with timed_out if it is still running.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, timeout_seconds: { type: 'number', description: `Default ${DEFAULT_WAIT_S}.` } }, required: ['id'] },
  },
  {
    name: 'wisp_reply',
    description:
      'Send a follow-up to a session; it resumes the same agent conversation. If the agent is waiting on a question, this answers it. ' +
      'A follow-up sent while it runs interrupts it (queue=true waits for the run to finish instead). mode switches the session’s mode from this follow-up on. ' +
      'agent / model / effort switch the harness, model or thinking level from this follow-up on (see wisp_agents); a new harness is handed the conversation so far.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        queue: { type: 'boolean' },
        mode: { type: 'string', enum: ['plan', 'edits', 'auto'] },
        agent: { type: 'string', description: 'Harness id, e.g. claude, codex, opencode' },
        model: { type: 'string', description: 'Model id for that harness; empty for its default' },
        effort: { type: 'string', description: 'Thinking level; empty for the default' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'wisp_stop',
    description: 'Stop a running session.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'wisp_agents',
    description: 'Which harnesses are installed, with their models and thinking levels, and the user’s machines (other computers, cloud computers) with theirs.',
    inputSchema: { type: 'object', properties: {} },
  },
  // wisp_crew_kit shows its files under a task's answer for the user to pick from: there's none here.
  ...CREW_TOOLS.filter((t) => t.name !== 'wisp_crew_kit'),
];
