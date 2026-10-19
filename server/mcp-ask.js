#!/usr/bin/env node
// Minimal stdio MCP server exposing `ask_user` and `wisp_stats`, injected into every agent wisp launches.
// The call is relayed to the wisp server, which surfaces it in the queue and blocks
// (by polling) until the user answers — so the agent keeps its full context.
// With a team (WISP_TEAM), it also offers `delegate` and `subagent_results`: tasks for the
// subagents the user picked, which wisp runs as child sessions while this call waits.
// With WISP_APPROVE, it offers `approve`: the harness's permission prompt (Claude's
// --permission-prompt-tool), answered by the user in wisp.
// `wisp_stats` is read-only: tool counts, spend and success rate across the user's wisp sessions.

import readline from 'node:readline';

const { WISP_URL, WISP_TOKEN, WISP_SESSION, WISP_APPROVE } = process.env;
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

async function stats({ days, agent, project } = {}) {
  const q = new URLSearchParams(Object.entries({ days, agent, project }).filter(([, v]) => v !== undefined && v !== ''));
  return (await call(`/api/internal/stats/${WISP_SESSION}?${q}`)).text;
}

const roster = TEAM.map((m) => `- ${m.name}${m.count > 1 ? ` ×${m.count} (parallel copies ${m.copies.join(', ')})` : ''}: ${[m.agent, m.model || 'default model', m.effort && `${m.effort} thinking`].filter(Boolean).join(' · ')}${m.use ? ` — use for: ${m.use}` : ''}`).join('\n');
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
      r = await call(`/api/internal/delegate/${WISP_SESSION}?ids=${encodeURIComponent((ids || []).join(','))}`);
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

async function call(path, body) {
  const res = await fetch(`${WISP_URL}${path}`, {
    method: body ? 'POST' : 'GET',
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
      send({ id, result: { tools: [TOOL, STATS, ...(WISP_APPROVE ? [APPROVE] : []), ...(TEAM.length ? TEAM_TOOLS : [])] } });
    } else if (method === 'tools/call' && params?.name === 'ask_user') {
      const answer = await askUser(params.arguments || {});
      const text = answer === null ? 'The user did not answer (the question was cancelled). Use your best judgment and note the assumption.' : `The user answered: ${answer}`;
      send({ id, result: { content: [{ type: 'text', text }] } });
    } else if (method === 'tools/call' && WISP_APPROVE && params?.name === 'approve') {
      send({ id, result: { content: [{ type: 'text', text: JSON.stringify(await approve(params.arguments || {})) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_stats') {
      send({ id, result: { content: [{ type: 'text', text: await stats(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && TEAM.length && params?.name === 'delegate') {
      send({ id, result: { content: [{ type: 'text', text: await delegate(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && TEAM.length && params?.name === 'subagent_results') {
      const a = params.arguments || {};
      send({ id, result: { content: [{ type: 'text', text: await results(a.ids, a.wait !== false) }] } });
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
