// `wisp mcp`: what each tool for the user's own agents and editors does (v1 server/mcp-wisp.js). v1 drove a
// running wisp over HTTP through the client SDK; here each is the owner's command, as the user.

import { COMMANDS as RUNTIME } from '@wisp-plugin/runtime-api';
import { EDIT_FIELDS, type MemberLike, memberDetail, memberLine } from './defs-crew.ts';
import { DEFAULT_WAIT_S } from './defs-user.ts';
import type { Changes } from './waits.ts';

export interface UserEnv {
  run<R>(cmd: string, args: unknown): Promise<R>;
  changes: Changes;
  now(): number;
  /** the folder the user's editor runs `wisp mcp` in (v1 process.cwd()) */
  cwd: string;
  signal?: AbortSignal | undefined;
}

/** Commands of other plugins `wisp mcp` runs that their api doesn't declare (yet). */
export const USER_COMMANDS = {
  markdown: 'runtime.markdown', // { id } → { markdown }   (v1 GET /api/sessions/:id/presentation)
  agents: 'runtime.agents', // {} → AgentView[]   (v1 GET /api/agents)
  machines: 'machines.list', // {} → PeerView[]
  crewList: 'crew.list', // {} → MemberLike[] (crew.view() of each)
  crewGet: 'crew.get', // { key } → MemberLike   (name, @handle or id; not_found when none)
  crewAdd: 'crew.add', // fields → MemberLike & { session?: { id } }
  crewUpdate: 'crew.update', // { id, fields } → MemberLike
  crewRemove: 'crew.remove', // { id } → {}
  crewImport: 'crew.import', // { url | text, dryRun?, choices? } → { spell?, members: { key, name }[] }
} as const;

type Args = Record<string, unknown>;

/** A session as `wisp mcp` reads it: v1's summary fields. */
interface SessionLike {
  id: string;
  title?: string;
  state?: string;
  agent?: string;
  cwd?: string;
  mode?: string;
  project?: string;
  preview?: string;
  live?: string;
  question?: string;
  forLater?: unknown;
  ask?: { question?: string } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
/** v1's states: 'waiting' while an ask is open. */
const stateOf = (s: SessionLike): string => (s.ask ? 'waiting' : str(s.state));

export const line = (s: SessionLike): string => {
  const state = stateOf(s);
  const question = s.question ?? s.ask?.question;
  return `- \`${s.id}\` **${str(s.title)}** — ${state}${s.forLater ? ' (for later)' : ''}${state === 'running' ? ` (${str(s.live)})` : s.preview ? `: ${s.preview}` : ''}${question ? ` — asks: ${question}` : ''} [${str(s.agent)}, ${str(s.project)}]`;
};

export async function describe(env: UserEnv, id: string, extra = ''): Promise<string> {
  const [s, p] = await Promise.all([env.run<SessionLike>(RUNTIME.get, { id }), env.run<{ markdown: string }>(USER_COMMANDS.markdown, { id })]);
  const state = stateOf(s);
  const head = `Session \`${id}\` — **${str(s.title)}** — state: **${state}**${extra}`;
  const hint = state === 'waiting' ? '\n\n_Answer with wisp_reply._' : state === 'running' ? '\n\n_Still running. Call wisp_wait to block until it finishes._' : '';
  return `${head}\n\n${p.markdown}${hint}`;
}

/** Until the session finishes or asks, or the time is up; then wisp_get's answer. */
async function waitFor(env: UserEnv, id: string, a: Args): Promise<string> {
  const end = env.now() + (Number(a['timeout_seconds']) || DEFAULT_WAIT_S) * 1000;
  const settled = await env.changes.until(
    async () => {
      const s = await env.run<SessionLike>(RUNTIME.get, { id });
      return stateOf(s) !== 'running' ? true : undefined;
    },
    { until: end, now: env.now, signal: env.signal },
  );
  return describe(env, id, settled ? '' : ' (timed out waiting; still running)');
}

const pick = (a: Args): Args => Object.fromEntries(EDIT_FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const handle = (v: unknown): string => str(v).replace(/^@/, '');

async function crewTool(env: UserEnv, name: string, a: Args): Promise<string> {
  switch (name) {
    case 'wisp_crew': {
      if (a['member']) return memberDetail(await env.run<MemberLike>(USER_COMMANDS.crewGet, { key: handle(a['member']) }));
      const list = await env.run<MemberLike[]>(USER_COMMANDS.crewList, {});
      return list.length ? list.map(memberLine).join('\n') : 'No crew yet. Add a member with wisp_crew_add.';
    }
    case 'wisp_crew_add': {
      if (a['from']) {
        const from = str(a['from']).trim();
        const src = /^(https:|gist:)/i.test(from) ? { url: from } : { text: from };
        const review = await env.run<{ spell?: unknown; members: { key: string }[] }>(USER_COMMANDS.crewImport, { ...src, dryRun: true });
        if (review.spell) return 'That is a spell, not a crew file: add it with `wisp spell install`.';
        const cwd = a['cwd'] ?? env.cwd;
        const r = await env.run<{ members: MemberLike[] }>(USER_COMMANDS.crewImport, { ...src, choices: Object.fromEntries(review.members.map((x) => [x.key, { cwd }])) });
        return `Added ${r.members.map((m) => m.name).join(', ')} to the crew, paused until the user resumes them.\n\n${r.members.map(memberLine).join('\n')}`;
      }
      const fields = pick(a);
      const m = await env.run<MemberLike & { session?: { id: string } }>(USER_COMMANDS.crewAdd, { ...fields, cwd: fields['cwd'] ?? env.cwd, checkin: a['checkin'] === true });
      return `Added ${m.name} to the crew.\n\n${memberLine(m)}${m.session ? `\n\nTheir first check-in is running (session \`${m.session.id}\`).` : ''}`;
    }
    case 'wisp_crew_edit': {
      const id = handle(a['member']);
      const fields = pick(a);
      // remember: lines added to the end of their notebook.
      const lines = (Array.isArray(a['remember']) ? a['remember'] : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 12);
      if (lines.length) fields['notebook'] = [fields['notebook'] ?? (await env.run<MemberLike>(USER_COMMANDS.crewGet, { key: id })).notebook, ...lines.map((x) => `- ${x.replace(/\s+/g, ' ').trim()}`)].filter(Boolean).join('\n');
      return `Updated.\n\n${memberLine(await env.run<MemberLike>(USER_COMMANDS.crewUpdate, { id, fields }))}`;
    }
    default: {
      const m = await env.run<MemberLike>(USER_COMMANDS.crewGet, { key: handle(a['member']) });
      await env.run(USER_COMMANDS.crewRemove, { id: m.id });
      return `Removed ${m.name} from the crew. Their jobs stay as ordinary sessions.`;
    }
  }
}

interface Agent {
  id: string;
  name?: string;
  available?: boolean;
  version?: string;
  models?: { id?: string }[];
}
interface Peer {
  id: string;
  name: string;
  state: string;
  remote?: { agents?: Agent[] } | null;
}

async function agents(env: UserEnv): Promise<string> {
  const here = (await env.run<Agent[]>(USER_COMMANDS.agents, {}))
    .map((x) => `- **${x.id}** (${str(x.name)}) — ${x.available ? `installed${x.version ? ` ${x.version}` : ''}; models: ${(x.models ?? []).map((m) => m.id).filter(Boolean).slice(0, 12).join(', ') || 'default'}` : 'not installed'}`)
    .join('\n');
  const ms = await env.run<Peer[]>(USER_COMMANDS.machines, {}).catch((): Peer[] => []);
  const there = ms.map((m) => `- \`${m.id}\` **${m.name}** — ${m.state}${m.remote?.agents ? `; harnesses: ${m.remote.agents.filter((x) => x.available).map((x) => x.id).join(', ') || 'none'}` : ''}`).join('\n');
  return `${here}\n\nMachines (pass machine to wisp_launch):\n${there || 'None.'}`;
}

async function launch(env: UserEnv, a: Args): Promise<string> {
  if (!str(a['prompt']).trim()) throw new Error('prompt is required');
  const { id } = await env.run<{ id: string }>(RUNTIME.create, {
    prompt: a['prompt'],
    cwd: a['cwd'] || env.cwd,
    ...(Array.isArray(a['also']) && { dirs: a['also'] }),
    ...Object.fromEntries(['agent', 'mode', 'model', 'effort', 'subagents', 'preset', 'machine'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])),
  });
  if (a['wait']) return waitFor(env, id, a);
  const s = await env.run<SessionLike>(RUNTIME.get, { id });
  return `Launched session \`${s.id}\` (“${str(s.title)}”) on ${str(s.agent)} in ${str(s.cwd)}, mode ${str(s.mode)}. Call wisp_wait or wisp_get with this id for the result.`;
}

/** A session list as v1's GET /api/sessions?state&cwd&limit filtered it. */
async function list(env: UserEnv, a: Args): Promise<string> {
  const states = a['state'] ? str(a['state']).split(',').map((x) => x.trim()) : null;
  const cwd = str(a['cwd']);
  const all = await env.run<SessionLike[]>(RUNTIME.list, {});
  const hits = all.filter((s) => (!states || states.includes(stateOf(s))) && (!cwd || str(s.cwd) === cwd || str(s.cwd).startsWith(`${cwd.replace(/\/+$/, '')}/`)));
  const out = hits.slice(0, Number(a['limit']) || 20);
  return out.length ? out.map(line).join('\n') : 'No sessions.';
}

/** The text a tool answers; throws a JSON-RPC -32602 for an unknown tool, as v1 did. */
export async function callUserTool(env: UserEnv, name: string, a: Args): Promise<string> {
  switch (name) {
    case 'wisp_launch':
      return launch(env, a);
    case 'wisp_list':
      return list(env, a);
    case 'wisp_get':
      return describe(env, str(a['id']));
    case 'wisp_wait':
      return waitFor(env, str(a['id']), a);
    case 'wisp_reply': {
      if (!str(a['text']).trim()) throw new Error('text is required');
      const run = Object.fromEntries(['agent', 'model', 'effort'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      const r = await env.run<{ answered?: boolean; interrupted?: boolean; queued?: unknown }>(RUNTIME.followUp, { id: str(a['id']), text: str(a['text']).trim(), ...(a['queue'] !== undefined && { queue: !!a['queue'] }), ...(a['mode'] !== undefined && { mode: a['mode'] }), ...(Object.keys(run).length && { run }) });
      return r.answered ? 'Answered the agent’s question; it is continuing.' : r.interrupted ? 'Interrupted the run; it resumes with your message.' : r.queued ? 'Queued; it goes out when the current run finishes.' : 'Sent; the agent is working on it.';
    }
    case 'wisp_stop':
      await env.run(RUNTIME.stop, { id: str(a['id']) });
      return `Stopped \`${str(a['id'])}\`.`;
    case 'wisp_agents':
      return agents(env);
    case 'wisp_crew':
    case 'wisp_crew_add':
    case 'wisp_crew_edit':
    case 'wisp_crew_remove':
      return crewTool(env, name, a);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}
