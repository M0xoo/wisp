// What each tool of a task's agent does (v1 server/mcp-ask.js): most are one command of the tool's owner,
// the port of the /api/internal route v1 called; ask_user, approve, the connector sign-in card, delegate's
// reports and wisp_task's wait are the waits this server owns, and they wait on events, not on a timer.

import { type McpSessionInfo, TOOL_COMMANDS, type AgentToolResult, type ToolContribution } from '@wisp-plugin/mcp-api';
import { COMMANDS as RUNTIME } from '@wisp-plugin/runtime-api';
import { MAX_WAIT_S, WAIT_S } from './defs-more.ts';
import type { Changes } from './waits.ts';

/** What a tool call runs with: who asks, and the kernel's way to run a command as them. */
export interface AgentEnv {
  session: string;
  info: McpSessionInfo;
  run<R>(cmd: string, args: unknown): Promise<R>;
  changes: Changes;
  now(): number;
  signal?: AbortSignal | undefined;
  /** one question at a time per session: a second sent at once would replace the first */
  chain: Map<string, Promise<unknown>>;
}

type Args = Record<string, unknown>;

interface PollAnswer {
  answer?: string;
  decision?: 'allow' | 'deny';
  message?: string;
  pending?: boolean;
  cancelled?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** The owner's answer: its text, or its refusal as the tool's error. */
async function owner(env: AgentEnv, cmd: string, args: Args): Promise<string> {
  const r = await env.run<AgentToolResult>(cmd, { ...args, session: env.session });
  if (r?.error) throw new Error(r.error);
  return r?.text ?? '';
}

/** An ask's answer once it's in ({ answer, … }), or null when it was cancelled or the wait ended. */
export async function waitFor(env: AgentEnv, askId: string): Promise<PollAnswer | null> {
  const got = await env.changes.until(
    async () => {
      const r = await env.run<PollAnswer>(RUNTIME.pollAnswer, { askId });
      if (r.answer !== undefined) return r;
      if (r.cancelled || !r.pending) return null;
      return undefined;
    },
    { until: Number.POSITIVE_INFINITY, now: env.now, signal: env.signal },
  );
  return got ?? null;
}

/** ask_user: one at a time per task; null when nobody answered. A capped task's ask stays a question. */
export function askUser(env: AgentEnv, a: Args): Promise<string | null> {
  const body = env.info.capped ? { question: a['question'], context: a['context'], options: a['options'] } : a;
  const ask = async (): Promise<string | null> => {
    const { askId } = await env.run<{ askId: string }>(RUNTIME.ask, { ...body, id: env.session });
    return (await waitFor(env, askId))?.answer ?? null;
  };
  const last = env.chain.get(env.session) ?? Promise.resolve();
  const turn = last.then(ask, ask);
  env.chain.set(env.session, turn);
  void turn.finally(() => env.chain.get(env.session) === turn && env.chain.delete(env.session)).catch(() => {});
  return turn;
}

/** Claude's permission-prompt contract: { behavior: 'allow', updatedInput } or { behavior: 'deny', message }. */
export async function approve(env: AgentEnv, a: Args): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }> {
  const input = a['input'] ?? {};
  let r: (PollAnswer & { id?: string }) | null = await env.run<PollAnswer & { id?: string }>(RUNTIME.approval, { id: env.session, tool: a['tool_name'], input, toolUseId: a['tool_use_id'] });
  if (r.id) r = await waitFor(env, r.id);
  if (r?.decision === 'allow') return { behavior: 'allow', updatedInput: input };
  if (!r) return { behavior: 'deny', message: 'The user did not answer (the request was cancelled). Do not retry it; carry on without it and say what was skipped.' };
  return { behavior: 'deny', message: r.message ? `The user denied this and said: ${r.message}` : 'The user denied this. Do not retry it; carry on without it or ask how to proceed.' };
}

async function connectorTool(env: AgentEnv, name: string, a: Args): Promise<string> {
  if (name === 'wisp_connectors') return owner(env, TOOL_COMMANDS.wisp_connectors, {});
  if (name === 'wisp_connector_add') {
    // A command that every later task would start: the user says so first.
    if (a['command'] && !a['url']) {
      const ok = await askUser(env, { question: `Add ${str(a['name']) || 'this'} as a connector? Every task will start it with: ${str(a['command'])}`, options: ['Add it', 'Don’t'] });
      if (ok !== 'Add it') return ok === null ? 'The user did not answer, so nothing was added.' : `The user didn’t want it added${ok && ok !== 'Don’t' ? ` and said: ${ok}` : ''}. Nothing was added.`;
    }
    return owner(env, TOOL_COMMANDS.wisp_connector_add, { ...a, transport: a['url'] ? 'remote' : 'local' });
  }
  const r = await env.run<AgentToolResult & { id?: string }>(TOOL_COMMANDS.wisp_connector_signin, { ...a, session: env.session });
  if (r.error) throw new Error(r.error);
  if (r.text) return r.text;
  const got = r.id ? await waitFor(env, r.id) : null;
  if (!got) return 'The card was cancelled; nothing changed. Carry on without it.';
  const answer = got.answer ?? '';
  if (/^Done: /.test(answer)) return `${answer.slice(6)}. Tasks get its tools from their next turn: harnesses load MCP servers when a turn starts, so this turn can't call them yet.`;
  return answer === 'Skip' ? 'The user skipped it for now; it stays in Settings → Connectors, where they can sign in later. Carry on without it.' : `The user answered instead: ${answer}`;
}

/** Until the task finishes or asks, or the time is up: its report either way. */
async function waitTask(env: AgentEnv, id: unknown, seconds: unknown): Promise<string> {
  const end = env.now() + Math.min(Math.max(Number(seconds) || WAIT_S, 1), MAX_WAIT_S) * 1000;
  const read = async (): Promise<AgentToolResult & { settled?: boolean; question?: string | null }> => {
    const r = await env.run<AgentToolResult & { settled?: boolean; question?: string | null }>(TOOL_COMMANDS.wisp_task_state, { session: env.session, of: str(id) });
    if (r.error) throw new Error(r.error);
    return r;
  };
  const r = await env.changes.until(async () => {
    const x = await read();
    return x.settled ? x : undefined;
  }, { until: end, now: env.now, signal: env.signal });
  if (r) return `${r.question ? `It is asking: ${r.question} (answer with wisp_task action "reply").\n\n` : ''}${r.text ?? ''}`;
  return `Still running (timed out waiting; call wait again for more).\n\n${(await read()).text ?? ''}`;
}

interface Delegation {
  id?: string;
  name?: string;
  subagent?: string;
  error?: string;
}

/** subagent_results: the reports, once every task is done (wait) or as they are now. */
async function results(env: AgentEnv, ids: unknown, wait = true): Promise<string> {
  const list = Array.isArray(ids) ? ids.map(str) : [];
  const read = (): Promise<{ done?: boolean; text?: string; reports?: string[] }> => env.run(RUNTIME.results, { id: env.session, ids: list, turn: env.info.turnId ?? '', wait: false });
  const text = (r: { text?: string; reports?: string[] }): string => r.text ?? (r.reports ?? []).join('\n\n---\n\n');
  if (!wait) return text(await read());
  const r = await env.changes.until(async () => {
    const x = await read();
    return x.done ? x : undefined;
  }, { until: Number.POSITIVE_INFINITY, now: env.now, signal: env.signal });
  if (!r) throw new Error('the wait ended: this turn is over, or wisp is going');
  return text(r);
}

async function delegate(env: AgentEnv, a: Args): Promise<string> {
  const out = await env.run<Delegation[] | { delegations: Delegation[] }>(RUNTIME.delegate, { id: env.session, tasks: a['tasks'] });
  const all = Array.isArray(out) ? out : out.delegations;
  const ok = all.filter((d) => !d.error);
  const errors = all.filter((d) => d.error).map((d) => `- ${str(d.subagent)}: ${str(d.error)}`).join('\n');
  if (!ok.length) return `Nothing was delegated.\n${errors}`;
  const head = errors ? `Some tasks were not delegated:\n${errors}\n\n` : '';
  if (a['wait'] === false) return `${head}Delegated: ${ok.map((d) => `${str(d.name)} (id ${str(d.id)})`).join(', ')}. Collect the reports with subagent_results.`;
  return head + (await results(env, ok.map((d) => d.id)));
}

const PASS: Readonly<Record<string, (a: Args) => [string, Args]>> = {
  resume_later: (a) => [TOOL_COMMANDS.resume_later, a],
  wisp_tag: (a) => [TOOL_COMMANDS.wisp_tag, { tags: a['tags'] }],
  wisp_pr: (a) => [TOOL_COMMANDS.wisp_pr, { pr: a['pr'], remove: !!a['remove'] }],
  wisp_watch: (a) => [TOOL_COMMANDS.wisp_watch, a],
  wisp_save: (a) => [TOOL_COMMANDS.wisp_save, a],
  wisp_stuff: (a) => [TOOL_COMMANDS.wisp_stuff, { id: a['id'], query: a['query'], kind: a['kind'], limit: a['limit'] }],
  wisp_blocks: (a) => [TOOL_COMMANDS.wisp_blocks, { types: a['types'] }],
  wisp_stats: (a) => [TOOL_COMMANDS.wisp_stats, { days: a['days'], agent: a['agent'], project: a['project'] }],
  wisp_sessions: (a) => [TOOL_COMMANDS.wisp_sessions, a],
  wisp_crew: (a) => [TOOL_COMMANDS.wisp_crew, a],
  wisp_crew_add: (a) => [TOOL_COMMANDS.wisp_crew_add, a],
  wisp_crew_edit: (a) => [TOOL_COMMANDS.wisp_crew_edit, a],
  wisp_crew_kit: (a) => [TOOL_COMMANDS.wisp_crew_kit, a],
  wisp_crew_remove: (a) => [TOOL_COMMANDS.wisp_crew_remove, a],
  wisp_available: () => [TOOL_COMMANDS.wisp_available, {}],
};
const SPELLS: Readonly<Record<string, string>> = {
  wisp_spells: TOOL_COMMANDS.wisp_spells,
  wisp_spell_schema: TOOL_COMMANDS.wisp_spell_schema,
  wisp_spell_data: TOOL_COMMANDS.wisp_spell_data,
  wisp_spell_check: TOOL_COMMANDS.wisp_spell_check,
};

/** The text a tool answers, or undefined when there's no such tool for this session (Method not found). */
export async function callAgentTool(env: AgentEnv, name: string, a: Args, extra: readonly ToolContribution[] = []): Promise<string | undefined> {
  const pass = PASS[name];
  if (pass && (name !== 'wisp_watch' || env.info.watch)) return owner(env, ...pass(a));
  switch (name) {
    case 'ask_user': {
      const answer = await askUser(env, a);
      return answer === null ? 'The user did not answer (the question was cancelled). Use your best judgment and note the assumption.' : `The user answered: ${answer}`;
    }
    case 'wisp_session':
      if (!a['id']) throw new Error('id is required');
      return owner(env, TOOL_COMMANDS.wisp_session, { of: str(a['id']), ...(a['turn'] !== undefined && { turn: a['turn'] }) });
    case 'wisp_connectors':
    case 'wisp_connector_add':
    case 'wisp_connector_signin':
      return connectorTool(env, name, a);
    case 'wisp_launch': {
      const { wait, timeout_seconds: seconds, ...body } = a;
      const r = await env.run<AgentToolResult & { ids?: string[] }>(TOOL_COMMANDS.wisp_launch, { ...body, session: env.session });
      if (r.error) throw new Error(r.error);
      const first = r.ids?.[0];
      return wait && first ? `${r.text ?? ''}\n\n---\n\n${await waitTask(env, first, seconds)}` : r.text ?? '';
    }
    case 'wisp_task':
      if (a['action'] === 'wait') return waitTask(env, a['task'], a['timeout_seconds']);
      return owner(env, TOOL_COMMANDS.wisp_task, a);
    case 'delegate':
      return delegate(env, a);
    case 'subagent_results':
      return results(env, a['ids'], a['wait'] !== false);
  }
  const spell = SPELLS[name];
  if (spell && env.info.spells) return owner(env, spell, a);
  const own = extra.find((c) => c.tool.name === name && c.for !== 'user');
  if (own) return owner(env, own.command, a);
  return undefined;
}
