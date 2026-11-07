// Connectors, spells, the team (delegate) and driving wisp (wisp_available, wisp_launch, wisp_task).
// Copied from v1 word for word (server/mcp-ask.js): agents read these, and test/goldens hold v1's own
// tools/list output for every mode. Change one only on purpose, with its golden.

import type { TeamEntry } from '@wisp-plugin/mcp-api';
import type { Tool } from './tool.ts';

export const WAIT_S = 240; // wisp_task wait / wisp_launch wait=true, unless the agent asks for longer
export const MAX_WAIT_S = 1800;
export const AGENTS = ['auto', 'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok', 'copilot'];

export const CONNECTOR_TOOLS: Tool[] = [
  {
    name: 'wisp_connectors',
    description:
      "List the user's connectors in wisp: MCP servers that every task's agent gets (in Edits and Full auto), whatever the harness. " +
      'Each with its URL or command and whether it works, how many tools it has, or what it needs (a sign-in, a key). Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_connector_add',
    description:
      'Add an MCP server to the user\'s connectors in wisp, when the user asks ("add PostHog", "connect Linear"). Remote: give its URL ' +
      '(for well-known services look up their official MCP URL, e.g. https://mcp.posthog.com/mcp). Local: give the command that starts it. ' +
      'Never pass secret values: list the names of the env vars (local) or headers (remote) it needs, and then call wisp_connector_signin, ' +
      'where the user signs in or types them. A local one asks the user first, since it runs a command on their computer. ' +
      'wisp checks it at once and says whether it works or what it needs. Tasks get it from their next turn.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase letters, digits and _, e.g. posthog. Not "wisp".' },
        url: { type: 'string', description: 'Remote: its https URL (Streamable HTTP, or an older one ending in /sse).' },
        command: { type: 'string', description: 'Local: the command line that starts it, e.g. "npx -y @modelcontextprotocol/server-filesystem ~/notes".' },
        env: { type: 'array', items: { type: 'string' }, description: 'Local: names of the env vars it needs a value for, e.g. ["GITHUB_TOKEN"]. Names only.' },
        headers: { type: 'array', items: { type: 'string' }, description: 'Remote, for servers that take an API key instead of a sign-in: header names, e.g. ["Authorization"]. Names only.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'wisp_connector_signin',
    description:
      'Show the user a card in this task to sign in to a connector (a Sign in button for servers with an account, like PostHog or Linear) ' +
      'or to type the keys it needs, and wait like ask_user. It ends on its own once the connector works, or when the user skips. ' +
      'Call it after wisp_connector_add or wisp_connectors says one needs a sign-in or keys.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The connector.' }, why: { type: 'string', description: 'One line for the card: what it is for, or where to find the key.' } },
      required: ['name'],
    },
  },
];

export const SPELL_TOOLS: Tool[] = [
  {
    name: 'wisp_spells',
    description: 'The spells the user has (on or off), each as its full JSON with a plain-words summary. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_spell_schema',
    description: 'The complete reference for writing a spell: fields, slots, parts, props, style properties, tokens, icons, actions, data sources and worked examples.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_spell_data',
    description: 'Run a spell data source and return a sample of its real answer, so script reads the right shape. Read-only (wisp GET routes from the allowlist, read-only gh commands).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'object', description: '{ "wisp": "/usage/tools?days=30" } or { "gh": ["search", "prs", "--author", "@me", "--json", "url,title"] }' },
        task: { type: 'string', description: 'Optional task id, to fill {field} templates in gh args from that task (e.g. {pr.number}).' },
      },
      required: ['source'],
    },
  },
  {
    name: 'wisp_spell_check',
    description: 'Validate a spell without installing it. Returns ok and what it does in plain words, or every problem to fix. The script is compiled, never run.',
    inputSchema: { type: 'object', properties: { spell: { type: 'object', description: 'The whole spell JSON.' } }, required: ['spell'] },
  },
];

export const teamTools = (TEAM: readonly TeamEntry[]): Tool[] => {
  const roster = TEAM.map((m) => `- ${m.name}${m.count > 1 ? ` ×${m.count} (parallel copies ${(m.copies ?? []).join(', ')})` : ''}: ${[m.agent, m.model || 'default model', m.effort && `${m.effort} thinking`, m.place && `on ${m.place}`].filter(Boolean).join(' · ')}${m.use ? ` — use for: ${m.use}` : ''}`).join('\n');
  return [
  {
    name: 'delegate',
    description:
      'Hand tasks to your subagents (separate coding agents the user picked, each on its own harness and model). ' +
      'Tasks in one call run in parallel in your working folder. By default the call waits until every task finishes and ' +
      'returns each report plus the files it changed; wait=false returns delegation ids at once. Delegating to a subagent ' +
      'again continues its conversation.' +
      (TEAM.length ? ' Use this instead of any built-in subagent or task tool.' : '') +
      ' A task can name a subagent of the team, or create one on the fly: agent (a harness), with model, effort and machine ' +
      '(to run it on one of the user\'s machines; wisp_available lists harnesses and machines) and a name; pass that name again to continue it. ' +
      'Create them when the user asks for subagents ("have codex review it", "run the tests on my devbox") or when parallel work on other harnesses pays off. ' +
      'A subagent on another machine gets a copy of your folder (wisp carries it: no commit or push needed): name files by their path in the folder, not absolute paths, and paste in what stays behind (git-ignored files, files outside the folder).' +
      (TEAM.length ? '\n\nThe team:\n' + roster : '\n\nNo team yet.'),
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              ...(TEAM.length && { subagent: { type: 'string', enum: TEAM.flatMap((m) => (m.count > 1 ? [m.name, ...(m.copies ?? [])] : [m.name])), description: 'A subagent of the team. A name with copies (×N) goes to a free copy; name a copy (x#2) to continue it.' } }),
              agent: { type: 'string', enum: AGENTS, description: 'Or a new subagent on this harness (auto: wisp picks harness and model).' },
              model: { type: 'string', description: 'With agent: its model id. Default: the harness default.' },
              effort: { type: 'string', description: 'With agent: thinking level, e.g. low | medium | high.' },
              machine: { type: 'string', description: 'With agent: run it on this machine (id or name from wisp_available). Default: this computer.' },
              name: { type: 'string', description: 'With agent: a short name for it ("reviewer"). Pass the same name later to continue that subagent.' },
              use: { type: 'string', description: 'With agent: what it is for, shown to the user.' },
              prompt: { type: 'string', description: 'The task, briefed like a colleague: goal, files, constraints, how to verify. It cannot see your conversation.' },
            },
            required: ['prompt'],
          },
        },
        wait: { type: 'boolean', description: 'Wait for all tasks to finish (default true).' },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'subagent_results',
    description: 'Wait for delegated tasks and return their reports. Pass the ids delegate returned; with none, every task delegated in this turn.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, wait: { type: 'boolean', description: 'Default true; false returns current status at once.' } } },
  },
];
};

export const CONTROL_TOOLS: Tool[] = [
  {
    name: 'wisp_available',
    description:
      'What the user has in wisp to run work on, in one read: harnesses on this computer (installed or not, models, thinking levels), ' +
      'their machines (other computers and cloud computers, online or not, the harnesses on each), projects, saved subagent presets, ' +
      'this task\'s own subagents and the crew. Read-only. Read it before you pick a harness, model or machine for delegate or wisp_launch.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_launch',
    description:
      'Start a new wisp task, as the user would from wisp\'s prompt box: its own agent, conversation and card, which the user follows ' +
      'and replies to on its own. Use it when the user asks you to start, kick off or hand off tasks ("start a task to…", "open a new ' +
      'conversation for…", "run this on my devbox"); for help with your own work, use delegate instead. Returns the new task\'s id at once ' +
      '(wait=true blocks until it finishes or asks). Show each task you start in your answer as a "task" block.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, briefed like a colleague: goal, constraints, how to verify. It cannot see your conversation.' },
        project: { type: 'string', description: 'A project by name or id (wisp_available lists them).' },
        cwd: { type: 'string', description: 'Or a folder (absolute path). Default: this task\'s project.' },
        scratch: { type: 'boolean', description: 'No project: an empty folder of its own (questions, research).' },
        also: { type: 'array', items: { type: 'string' }, description: 'More folders the same task works in (absolute paths).' },
        machine: { type: 'string', description: 'Run it on this machine (id or name). Default: where the project is, else this computer.' },
        agent: { type: 'string', enum: AGENTS, description: 'Harness. Default: the user\'s default.' },
        model: { type: 'string', description: 'Model id for that harness.' },
        effort: { type: 'string', description: 'Thinking level.' },
        mode: { type: 'string', enum: ['plan', 'edits', 'auto'], description: 'plan = read-only, edits = auto-accept edits, auto = no prompts. Default: the user\'s.' },
        worktree: { type: 'boolean', description: 'Its own git worktree (default on in git repos, except in plan mode).' },
        subagents: {
          type: 'array',
          description: 'A team the new task\'s agent can delegate to: [{ agent, model?, effort?, machine?, name?, use?, count? }].',
          items: { type: 'object', properties: { agent: { type: 'string', enum: AGENTS }, model: { type: 'string' }, effort: { type: 'string' }, machine: { type: 'string' }, name: { type: 'string' }, use: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['agent'] },
        },
        preset: { type: 'string', description: 'Or a saved subagent preset\'s id.' },
        wait: { type: 'boolean', description: 'Block until it finishes or asks (up to timeout_seconds).' },
        timeout_seconds: { type: 'number', description: `With wait: default ${WAIT_S}, at most ${MAX_WAIT_S}.` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'wisp_task',
    description:
      'Act on another wisp task, as the user would from its card. action: reply (a follow-up, or the answer when it is asking; agent, ' +
      'model, effort or mode switch it from then on; queue=true waits for its current run instead of interrupting), stop, done (mark it ' +
      'done), archive, unarchive, rename (title), or wait (block until it finishes or asks, then return its report). Only when the user ' +
      'asks, or for tasks you started. Find tasks with wisp_sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task id.' },
        action: { type: 'string', enum: ['reply', 'stop', 'done', 'archive', 'unarchive', 'rename', 'wait'] },
        text: { type: 'string', description: 'reply: the message.' },
        queue: { type: 'boolean', description: 'reply: wait for its current run instead of interrupting it.' },
        mode: { type: 'string', enum: ['plan', 'edits', 'auto'] },
        agent: { type: 'string', enum: AGENTS },
        model: { type: 'string' },
        effort: { type: 'string' },
        title: { type: 'string', description: 'rename: the new title.' },
        timeout_seconds: { type: 'number', description: `wait: default ${WAIT_S}, at most ${MAX_WAIT_S}.` },
      },
      required: ['task', 'action'],
    },
  },
];
