// resume_later: the agent schedules a follow-up into its own task, or cancels one it made (v1
// routes/internal.js POST /internal/later; the MCP tool runs `later.agent.schedule`, mcp-api TOOL_COMMANDS).
import type { CallContext } from '@wisp/kernel';
import type { Json } from '@wisp/kernel';
import { CREW_GET } from './peers.ts';
import type { CrewMember } from './peers.ts';
import { Rt } from './rt.ts';
import type { Tasks } from './tasks.ts';

export interface ScheduleArgs {
  session?: unknown;
  minutes?: unknown;
  at?: unknown;
  message?: unknown;
  cancel?: unknown;
}

const when = (t: number): string => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Who the follow-up is by: a crew member's job is by that member, any other task's by its agent. */
async function byOf(call: CallContext, crew: Json | undefined): Promise<string> {
  const id = typeof crew === 'object' && crew !== null && !Array.isArray(crew) && typeof crew['id'] === 'string' ? crew['id'] : undefined;
  if (!id) return 'agent';
  const m = await call.run<CrewMember>(CREW_GET, { id }).catch(() => undefined);
  return m?.name || 'agent';
}

export async function agentSchedule(tasks: Tasks, call: CallContext, a: ScheduleArgs): Promise<{ text?: string; error?: string }> {
  const id = String(a.session ?? '');
  // an agent's token speaks for its own task only
  const speaks = call.trace.caller.session;
  if (speaks !== undefined && speaks !== id) return { error: 'bad token' };
  const s = await new Rt(call).get(id);
  if (!s) return { error: 'no such session' };
  if (s.parentId) return { error: 'A subagent can’t schedule follow-ups; say in your report what should be checked later, and your lead can.' };
  const by = await byOf(call, s.ext['wisp.crew']);
  const mine = tasks.rows.entries(s.id).filter((l) => l.by === by);
  if (a.cancel) {
    const ok = mine.some((l) => l.id === a.cancel) && (await tasks.cancel(call, s.id, { item: String(a.cancel) })).ok;
    return { text: ok ? 'Cancelled.' : 'No follow-up of yours with that id is pending.' };
  }
  const minutes = a.minutes !== undefined ? Number(a.minutes) : undefined;
  if (a.at !== undefined && typeof a.at === 'string' && !/(Z|[+-]\d\d:?\d\d)$/.test(a.at.trim())) return { error: 'at must be an ISO time with its offset (2026-10-25T14:30+02:00), or use minutes.' };
  let l;
  try {
    l = await tasks.addTo(call, s, { sessionId: s.id, text: a.message, by, ...(minutes !== undefined ? { in: minutes } : { at: a.at }) });
  } catch (e) {
    return { error: (e as Error).message };
  }
  const now = call.clock.now();
  const others = tasks.rows.entries(s.id).filter((x) => x.id !== l.id).map((x) => `- ${x.id} at ${when(x.at)}: ${clip(x.text, 80)}`).join('\n');
  return { text: `Scheduled (id ${l.id}) for ${when(l.at)}, in ${Math.round((l.at - now) / 60_000)} min. Finish your turn now with your report, saying what you'll check then; wisp resumes this conversation at that time with your message.${others ? `\nAlso pending on this task:\n${others}` : ''}` };
}
