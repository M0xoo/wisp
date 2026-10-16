#!/usr/bin/env node
// Minimal stdio MCP server exposing `ask_user`, injected into every agent wisp launches.
// The call is relayed to the wisp server, which surfaces it in the queue and blocks
// (by polling) until the user answers — so the agent keeps its full context.

import readline from 'node:readline';

const { WISP_URL, WISP_TOKEN, WISP_SESSION } = process.env;

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

async function askUser(args) {
  const { id } = await call(`/api/internal/ask`, { session: WISP_SESSION, ...args });
  for (;;) {
    await sleep(1500);
    let r;
    try {
      r = await call(`/api/internal/ask/${id}`);
    } catch {
      continue; // wisp restarting — keep waiting
    }
    if (r.answer !== undefined) return r.answer;
    if (r.cancelled) return null;
  }
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
      send({ id, result: { tools: [TOOL] } });
    } else if (method === 'tools/call' && params?.name === 'ask_user') {
      const answer = await askUser(params.arguments || {});
      const text = answer === null ? 'The user did not answer (the question was cancelled). Use your best judgment and note the assumption.' : `The user answered: ${answer}`;
      send({ id, result: { content: [{ type: 'text', text }] } });
    } else if (method === 'ping') {
      send({ id, result: {} });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    send({ id, result: { isError: true, content: [{ type: 'text', text: `wisp could not reach the user: ${err.message}` }] } });
  }
});
