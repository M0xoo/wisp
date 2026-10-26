#!/usr/bin/env node
// Minimal stdio MCP server exposing `ask_user`, `wisp_stats`, `wisp_sessions` and `wisp_session`, injected into every agent wisp launches.
// The call is relayed to the wisp server, which surfaces it in the queue and blocks
// (by polling) until the user answers — so the agent keeps its full context.
// With a team (WISP_TEAM), it also offers `delegate` and `subagent_results`: tasks for the
// subagents the user picked, which wisp runs as child sessions while this call waits.
// With WISP_APPROVE, it offers `approve`: the harness's permission prompt (Claude's
// --permission-prompt-tool), answered by the user in wisp.
// `resume_later` schedules a follow-up to this same task (server/later.js).
// `wisp_stats` is read-only: tool counts, spend and success rate across the user's wisp sessions.
// `wisp_sessions` and `wisp_session` are read-only too: list the user's other tasks and read one's
// reports, e.g. a task the user mentioned in the prompt.
// `wisp_crew`, `wisp_crew_add`, `wisp_crew_edit` and `wisp_crew_remove` read and change the user's crew
// (server/crew.js) when the user asks; wisp refuses changes from subagents and crew members' jobs.
// `wisp_crew_kit` proposes skills and instructions files for a member: the task shows them for the
// user to pick from, so a member's job may call it too.
// `wisp_connectors`, `wisp_connector_add` and `wisp_connector_signin` read and add the user's
// connectors (MCP servers every task gets, server/connectors.js); secret values never pass through
// the agent: the sign-in card takes them.
// With WISP_SPELLS (a Cast a spell task): `wisp_spells`, `wisp_spell_schema`, `wisp_spell_data` and
// `wisp_spell_check`, to write a spell for the user to keep.

import readline from 'node:readline';
import { CREW_TOOLS } from './crew-tools.js';

const { WISP_URL, WISP_TOKEN, WISP_SESSION, WISP_TURN, WISP_APPROVE, WISP_SPELLS } = process.env;
let TEAM = [];
try {
  TEAM = JSON.parse(process.env.WISP_TEAM || '[]');
} catch {}

const TOOL = {
  name: 'ask_user',
  description:
    'Ask the user a question through wisp and wait for their answer. Use when a decision would change the rest of your work ' +
    '(ambiguous requirements, risky/destructive steps, choosing between approaches). The user may take minutes or hours to answer. ' +
    'Do not use it for trivial choices you can make yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, one or two sentences.' },
      context: { type: 'string', description: 'Optional markdown: what you found so far and why you are asking.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers (2–4). The user can always type their own.' },
    },
    required: ['question'],
  },
};

// resume_later: a follow-up into this same task at a later time (server/later.js).
const LATER = {
  name: 'resume_later',
  description:
    'Schedule a follow-up to this same task: at that time wisp sends your message back to you in this conversation, with your full context, ' +
    'as if the user had typed it. Use it when you must wait before you can go on (a deploy rolling out, CI running, a rate limit, ' +
    '"check again in 10 minutes"), or when the user asks you to do something later ("in 5 minutes do X"). After scheduling, end your turn ' +
    'with your report saying what you will check then; do not sleep or poll. Pass cancel with an id to drop one you scheduled.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Minutes from now (1 to 10080).' },
      at: { type: 'string', description: 'Or an ISO time with its offset, e.g. 2026-10-25T14:30+02:00.' },
      message: { type: 'string', description: 'What to do then, written to yourself: the check to run and what to do with the result.' },
      cancel: { type: 'string', description: 'The id of a follow-up you scheduled, to cancel it instead.' },
    },
  },
};

// Claude's permission-prompt contract: { tool_name, input, tool_use_id } in, a JSON
// { behavior: 'allow', updatedInput } or { behavior: 'deny', message } back as text.
const APPROVE = {
  name: 'approve',
  description: 'Internal: wisp asks the user to approve a tool call your permissions do not allow on their own. Never call this yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name'],
  },
};

const STATS = {
  name: 'wisp_stats',
  description:
    'Read-only stats about the user\'s past wisp tasks: how many tool calls each kind of action made (run = shell, read, edit, ' +
    'search, web, agent, tool = other MCP tools, ask), broken down by harness, project and day, plus turns, cost, tokens and ' +
    'success rate. Use when the user asks about their wisp usage, which tools or harnesses their tasks use, or what tasks cost.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'How many days back, 1–365. Default 30.' },
      agent: { type: 'string', description: 'Only this harness, e.g. claude, codex, opencode.' },
      project: { type: 'string', description: 'Only this project (name or id); "current" = the project of this task.' },
    },
  },
};

const SESSIONS = {
  name: 'wisp_sessions',
  description:
    'List the user\'s other wisp tasks, newest first: id, title, state (running | waiting | review | done), harness, project, ' +
    'last update and a one-line summary. Read-only. Use it to find a task the user refers to; read one with wisp_session.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Only tasks whose title or summary has all these words.' },
      state: { type: 'string', description: 'Comma-separated, e.g. "running,waiting".' },
      project: { type: 'string', description: 'Only this project (name or id); "current" = the project of this task.' },
      archived: { type: 'boolean', description: 'Include archived tasks. Default false.' },
      limit: { type: 'number', description: 'Default 20, at most 100.' },
    },
  },
};

const SESSION = {
  name: 'wisp_session',
  description:
    'Read another wisp task by id: its title, state, harness, folder and branch, every request the user made in it, and a ' +
    'turn\'s report as markdown (summary, diffs, tests, next steps). Read-only. Use it when the prompt mentions a wisp task ' +
    '("@Title (wisp task <id>)") or the user asks what another task did.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The task id.' },
      turn: { type: 'number', description: 'Which turn\'s report, 1 = first. Default: the latest.' },
    },
    required: ['id'],
  },
};

async function crewTool(name, args = {}) {
  const path = `/api/internal/crew/${WISP_SESSION}`;
  const r =
    name === 'wisp_crew'
      ? await call(args.member ? `${path}?member=${encodeURIComponent(args.member)}` : path)
      : name === 'wisp_crew_kit'
        ? await call(`${path}/kit`, args)
        : await call(path, args, { wisp_crew_add: 'POST', wisp_crew_edit: 'PATCH', wisp_crew_remove: 'DELETE' }[name]);
  if (r.error) throw new Error(r.error);
  return r.text;
}

const CONNECTOR_TOOLS = [
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

async function connectorTool(name, args = {}) {
  const path = `/api/internal/connectors/${WISP_SESSION}`;
  if (name === 'wisp_connectors') return (await call(path)).text;
  if (name === 'wisp_connector_add') {
    // A command that every later task would start: the user says so first.
    if (args.command && !args.url) {
      const ok = await askUser({ question: `Add ${args.name || 'this'} as a connector? Every task will start it with: ${args.command}`, options: ['Add it', 'Don’t'] });
      if (ok !== 'Add it') return ok === null ? 'The user did not answer, so nothing was added.' : `The user didn’t want it added${ok && ok !== 'Don’t' ? ` and said: ${ok}` : ''}. Nothing was added.`;
    }
    const r = await call(path, { ...args, transport: args.url ? 'remote' : 'local' });
    if (r.error) throw new Error(r.error);
    return r.text;
  }
  const r = await call(`${path}/signin`, args);
  if (r.error) throw new Error(r.error);
  if (r.text) return r.text;
  const a = await waitFor(r.id);
  if (!a) return 'The card was cancelled; nothing changed. Carry on without it.';
  if (/^Done: /.test(a.answer)) return `${a.answer.slice(6)}. Tasks get its tools from their next turn: harnesses load MCP servers when a turn starts, so this turn can't call them yet.`;
  return a.answer === 'Skip' ? 'The user skipped it for now; it stays in Settings → Connectors, where they can sign in later. Carry on without it.' : `The user answered instead: ${a.answer}`;
}

// Cast a spell tasks (WISP_SPELLS) get the tools to write one: what's installed, the reference,
// a data source's real answer, and a check that validates without installing anything.
const SPELL_TOOLS = [
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

async function spellTool(name, args = {}) {
  if (name === 'wisp_spell_data') return (await call(`/api/internal/spell-data/${WISP_SESSION}`, args)).text;
  if (name === 'wisp_spell_check') return (await call(`/api/internal/spell-check/${WISP_SESSION}`, args)).text;
  return (await call(`/api/internal/${name === 'wisp_spells' ? 'spells' : 'spell-schema'}/${WISP_SESSION}`)).text;
}

async function sessions(args = {}) {
  const q = new URLSearchParams(Object.entries(args).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  return (await call(`/api/internal/sessions/${WISP_SESSION}?${q}`)).text;
}

async function session({ id, turn } = {}) {
  if (!id) throw new Error('id is required');
  const q = new URLSearchParams({ of: String(id), ...(turn !== undefined && { turn: String(turn) }) });
  return (await call(`/api/internal/session/${WISP_SESSION}?${q}`)).text;
}

async function stats({ days, agent, project } = {}) {
  const q = new URLSearchParams(Object.entries({ days, agent, project }).filter(([, v]) => v !== undefined && v !== ''));
  return (await call(`/api/internal/stats/${WISP_SESSION}?${q}`)).text;
}

const roster = TEAM.map((m) => `- ${m.name}${m.count > 1 ? ` ×${m.count} (parallel copies ${m.copies.join(', ')})` : ''}: ${[m.agent, m.model || 'default model', m.effort && `${m.effort} thinking`, m.place && `on ${m.place}`].filter(Boolean).join(' · ')}${m.use ? ` — use for: ${m.use}` : ''}`).join('\n');
const TEAM_TOOLS = [
  {
    name: 'delegate',
    description:
      'Hand tasks to your subagents (separate coding agents the user picked, each on its own harness and model). ' +
      'Tasks in one call run in parallel in your working folder. By default the call waits until every task finishes and ' +
      'returns each report plus the files it changed; wait=false returns delegation ids at once. Delegating to a subagent ' +
      'again continues its conversation. Use this instead of any built-in subagent or task tool.\n\nThe team:\n' + roster,
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              subagent: { type: 'string', enum: TEAM.flatMap((m) => (m.count > 1 ? [m.name, ...m.copies] : [m.name])), description: 'Which subagent. A name with copies (×N) goes to a free copy; name a copy (x#2) to continue it.' },
              prompt: { type: 'string', description: 'The task, briefed like a colleague: goal, files, constraints, how to verify. It cannot see your conversation.' },
            },
            required: ['subagent', 'prompt'],
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

async function results(ids, wait = true) {
  for (;;) {
    let r;
    try {
      r = await call(`/api/internal/delegate/${WISP_SESSION}?ids=${encodeURIComponent((ids || []).join(','))}&turn=${WISP_TURN || ''}`);
    } catch (err) {
      if (!wait) throw err;
      await sleep(1500);
      continue; // wisp restarting — keep waiting
    }
    if (r.done || !wait) return r.text;
    await sleep(1500);
  }
}

async function delegate({ tasks, wait = true }) {
  const r = await call(`/api/internal/delegate/${WISP_SESSION}`, { tasks });
  const ok = r.delegations.filter((d) => !d.error);
  const errors = r.delegations.filter((d) => d.error).map((d) => `- ${d.subagent}: ${d.error}`).join('\n');
  if (!ok.length) return `Nothing was delegated.\n${errors}`;
  const head = errors ? `Some tasks were not delegated:\n${errors}\n\n` : '';
  if (!wait) return `${head}Delegated: ${ok.map((d) => `${d.name} (id ${d.id})`).join(', ')}. Collect the reports with subagent_results.`;
  return head + (await results(ok.map((d) => d.id)));
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(`${WISP_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-wisp-token': WISP_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`wisp ${res.status}: ${await res.text()}`);
  return res.json();
}

// Poll a question until it's answered ({ answer, … }) or cancelled (null).
async function waitFor(id) {
  for (;;) {
    await sleep(1500);
    let r;
    try {
      r = await call(`/api/internal/ask/${id}`);
    } catch {
      continue; // wisp restarting — keep waiting
    }
    if (r.answer !== undefined) return r;
    if (r.cancelled) return null;
  }
}

async function askUser(args) {
  const { id } = await call(`/api/internal/ask`, { session: WISP_SESSION, ...args });
  return (await waitFor(id))?.answer ?? null;
}

async function approve({ tool_name: tool, input = {} }) {
  let r = await call(`/api/internal/approve`, { session: WISP_SESSION, tool, input });
  if (r.id) r = await waitFor(r.id);
  if (r?.decision === 'allow') return { behavior: 'allow', updatedInput: input };
  if (!r) return { behavior: 'deny', message: 'The user did not answer (the request was cancelled). Do not retry it; carry on without it and say what was skipped.' };
  return { behavior: 'deny', message: r.message ? `The user denied this and said: ${r.message}` : 'The user denied this. Do not retry it; carry on without it or ask how to proceed.' };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  try {
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wisp', version: '0.1.0' } } });
    } else if (method === 'tools/list') {
      send({ id, result: { tools: [TOOL, LATER, STATS, SESSIONS, SESSION, ...CREW_TOOLS, ...CONNECTOR_TOOLS, ...(WISP_APPROVE ? [APPROVE] : []), ...(TEAM.length ? TEAM_TOOLS : []), ...(WISP_SPELLS ? SPELL_TOOLS : [])] } });
    } else if (method === 'tools/call' && params?.name === 'ask_user') {
      const answer = await askUser(params.arguments || {});
      const text = answer === null ? 'The user did not answer (the question was cancelled). Use your best judgment and note the assumption.' : `The user answered: ${answer}`;
      send({ id, result: { content: [{ type: 'text', text }] } });
    } else if (method === 'tools/call' && params?.name === 'resume_later') {
      const a = params.arguments || {};
      send({ id, result: { content: [{ type: 'text', text: (await call(`/api/internal/later`, { session: WISP_SESSION, ...a })).text }] } });
    } else if (method === 'tools/call' && WISP_APPROVE && params?.name === 'approve') {
      send({ id, result: { content: [{ type: 'text', text: JSON.stringify(await approve(params.arguments || {})) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_stats') {
      send({ id, result: { content: [{ type: 'text', text: await stats(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_sessions') {
      send({ id, result: { content: [{ type: 'text', text: await sessions(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_session') {
      send({ id, result: { content: [{ type: 'text', text: await session(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && CREW_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await crewTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'tools/call' && CONNECTOR_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await connectorTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'tools/call' && TEAM.length && params?.name === 'delegate') {
      send({ id, result: { content: [{ type: 'text', text: await delegate(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && TEAM.length && params?.name === 'subagent_results') {
      const a = params.arguments || {};
      send({ id, result: { content: [{ type: 'text', text: await results(a.ids, a.wait !== false) }] } });
    } else if (method === 'tools/call' && WISP_SPELLS && SPELL_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await spellTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'ping') {
      send({ id, result: {} });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    const what = params?.name === 'ask_user' || params?.name === 'approve' ? 'wisp could not reach the user' : 'wisp';
    // A permission prompt that errors would leave the harness guessing: deny, and say why.
    if (params?.name === 'approve') send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: `${what}: ${err.message}` }) }] } });
    else send({ id, result: { isError: true, content: [{ type: 'text', text: `${what}: ${err.message}` }] } });
  }
});
