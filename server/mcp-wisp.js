// `wisp mcp`: a stdio MCP server that lets any MCP-capable agent or editor (Claude Code, Codex,
// opencode, Cursor, Antigravity, Grok, Copilot, Claude Desktop, Zed, …) hand tasks to wisp and read the results back,
// and manage the user's crew.
// It talks to the running wisp over HTTP (starting a headless one if needed) via the client SDK.
//
//   claude mcp add wisp -- npx -y wisp-agents mcp

import readline from 'node:readline';
import { WispClient } from './client.js';
import { VERSION } from './util.js';
import { CREW_TOOLS, EDIT_FIELDS, memberDetail, memberLine } from './crew-tools.js';

const AGENTS = ['auto', 'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok', 'copilot'];
const DEFAULT_WAIT_S = 240; // stay under typical MCP client tool-call timeouts; call wisp_wait again for more

const TOOLS = [
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

let client;
const wisp = async () => (client ||= await WispClient.connect());

const line = (s) => `- \`${s.id}\` **${s.title}** — ${s.state}${s.forLater ? ' (for later)' : ''}${s.state === 'running' ? ` (${s.live})` : s.preview ? `: ${s.preview}` : ''}${s.question ? ` — asks: ${s.question}` : ''} [${s.agent}, ${s.project}]`;

async function describe(id, extra = '') {
  const c = await wisp();
  const [s, p] = await Promise.all([c.session(id), c.presentation(id)]);
  const head = `Session \`${id}\` — **${s?.title}** — state: **${s?.state}**${extra}`;
  const hint =
    s?.state === 'waiting' ? '\n\n_Answer with wisp_reply._' : s?.state === 'running' ? '\n\n_Still running. Call wisp_wait to block until it finishes._' : '';
  return `${head}\n\n${p.markdown}${hint}`;
}

const pick = (a) => Object.fromEntries(EDIT_FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

async function callTool(name, a = {}) {
  const c = await wisp();
  const waitFor = async (id) => {
    const s = await c.wait(id, { timeoutMs: (Number(a.timeout_seconds) || DEFAULT_WAIT_S) * 1000 });
    return describe(id, s.timedOut ? ' (timed out waiting; still running)' : '');
  };
  switch (name) {
    case 'wisp_launch': {
      if (!a.prompt?.trim()) throw new Error('prompt is required');
      const s = await c.launch({ prompt: a.prompt, cwd: a.cwd || process.cwd(), also: Array.isArray(a.also) ? a.also : undefined, agent: a.agent, mode: a.mode, model: a.model, effort: a.effort, subagents: a.subagents, preset: a.preset, machine: a.machine });
      if (a.wait) return waitFor(s.id);
      return `Launched session \`${s.id}\` (“${s.title}”) on ${s.agent} in ${s.cwd}, mode ${s.mode}. Call wisp_wait or wisp_get with this id for the result.`;
    }
    case 'wisp_list': {
      const list = await c.sessions({ state: a.state, cwd: a.cwd, limit: Number(a.limit) || 20 });
      return list.length ? list.map(line).join('\n') : 'No sessions.';
    }
    case 'wisp_get':
      return describe(a.id);
    case 'wisp_wait':
      return waitFor(a.id);
    case 'wisp_reply': {
      if (!a.text?.trim()) throw new Error('text is required');
      const r = await c.reply(a.id, a.text.trim(), { queue: a.queue, mode: a.mode, agent: a.agent, model: a.model, effort: a.effort });
      return r.answered ? 'Answered the agent’s question; it is continuing.' : r.interrupted ? 'Interrupted the run; it resumes with your message.' : r.queued ? 'Queued; it goes out when the current run finishes.' : 'Sent; the agent is working on it.';
    }
    case 'wisp_stop':
      await c.stop(a.id);
      return `Stopped \`${a.id}\`.`;
    case 'wisp_agents': {
      const here = (await c.agents())
        .map((x) => `- **${x.id}** (${x.name}) — ${x.available ? `installed${x.version ? ` ${x.version}` : ''}; models: ${(x.models || []).map((m) => m.id).filter(Boolean).slice(0, 12).join(', ') || 'default'}` : 'not installed'}`)
        .join('\n');
      const ms = await c.machines().catch(() => []);
      const there = ms.map((m) => `- \`${m.id}\` **${m.name}** — ${m.state}${m.remote?.agents ? `; harnesses: ${m.remote.agents.filter((a) => a.available).map((a) => a.id).join(', ') || 'none'}` : ''}`).join('\n');
      return `${here}\n\nMachines (pass machine to wisp_launch):\n${there || 'None.'}`;
    }
    case 'wisp_crew': {
      if (a.member) return memberDetail(await c.crewMember(String(a.member).replace(/^@/, '')));
      const list = await c.crew();
      return list.length ? list.map(memberLine).join('\n') : 'No crew yet. Add a member with wisp_crew_add.';
    }
    case 'wisp_crew_add': {
      if (a.from) {
        const from = String(a.from).trim();
        const src = /^(https:|gist:)/i.test(from) ? { url: from } : { text: from };
        const review = await c.importCrew({ ...src, dryRun: true });
        if (review.spell) return 'That is a spell, not a crew file: add it with `wisp spell install`.';
        const r = await c.importCrew({ ...src, choices: Object.fromEntries(review.members.map((x) => [x.key, { cwd: a.cwd ?? process.cwd() }])) });
        return `Added ${r.members.map((m) => m.name).join(', ')} to the crew, paused until the user resumes them.\n\n${r.members.map(memberLine).join('\n')}`;
      }
      const fields = pick(a);
      const m = await c.addCrew({ ...fields, cwd: fields.cwd ?? process.cwd(), checkin: a.checkin === true });
      return `Added ${m.name} to the crew.\n\n${memberLine(m)}${m.session ? `\n\nTheir first check-in is running (session \`${m.session.id}\`).` : ''}`;
    }
    case 'wisp_crew_edit': {
      const id = String(a.member || '').replace(/^@/, '');
      const fields = pick(a);
      // remember: lines added to the end of their notebook.
      const lines = (Array.isArray(a.remember) ? a.remember : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 12);
      if (lines.length) fields.notebook = [fields.notebook ?? (await c.crewMember(id)).notebook, ...lines.map((x) => `- ${x.replace(/\s+/g, ' ').trim()}`)].filter(Boolean).join('\n');
      return `Updated.\n\n${memberLine(await c.updateCrew(id, fields))}`;
    }
    case 'wisp_crew_remove': {
      const m = await c.crewMember(String(a.member || '').replace(/^@/, ''));
      await c.removeCrew(m.id);
      return `Removed ${m.name} from the crew. Their jobs stay as ordinary sessions.`;
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

export function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  readline.createInterface({ input }).on('line', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    if (method === 'initialize')
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'wisp', version: VERSION },
          instructions: 'wisp runs coding agents in the background. Launch with wisp_launch, then wisp_wait / wisp_get for the result; wisp_reply to follow up or answer a question. wisp_crew* manage the user\'s crew of long-lived agents.',
        },
      });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params?.name, params?.arguments || {});
        return send({ id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        if (err.code === -32602) return send({ id, error: { code: err.code, message: err.message } });
        return send({ id, result: { isError: true, content: [{ type: 'text', text: `wisp: ${err.message}` }] } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  });
}
