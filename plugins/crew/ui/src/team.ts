// The lead's team (v1 team.js teamLiveHtml / renderSubs, F-crew-11): the crew jobs a task handed out (delegated,
// tagged, or asked from its reply box with `@Ada`: a job whose `from` is this task), one row each in the order they went, each opening the job (a task of its own). Pure: the rows
// from the crew's jobs and members; the pane lays them out and opens them.
import type { SessionRow } from './types.ts';

export type Say = (k: string, v?: Readonly<Record<string, string | number>>) => string;

export interface TeamMember {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly color?: string;
}

export interface TeamRow {
  /** the job's task id */
  readonly id: string;
  readonly member: string;
  readonly name: string;
  readonly avatar: string;
  readonly color: string;
  /** "@Ada" */
  readonly handle: string;
  /** what it is doing (live), else what it came back with, else what it was asked */
  readonly line: string;
  readonly status: string;
  readonly tone: 'accent' | 'warn' | 'good' | 'bad' | 'neutral';
  readonly live: boolean;
  /** its job is still being made (crew.assign's optimistic row): nothing to open yet */
  readonly pending: boolean;
}

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);
/** the lead a job came from: the task key's id or the key itself */
const fromLead = (s: SessionRow, lead: string): boolean => {
  const f = s.crew?.from?.id;
  return !!f && (f === lead || f === bare(lead) || bare(f) === bare(lead));
};

// a job you sent from the member's page has no `from`; a check-in or a trigger's isn't this task's work
const handedOut = (s: SessionRow, lead: string): boolean => (s.crew?.job === 'delegated' || s.crew?.job === 'mention' || s.crew?.job === 'task') && fromLead(s, lead);

/** Whether task `lead` handed any crew job out (its Team tab shows). */
export const hasTeam = (jobs: readonly SessionRow[], lead: string): boolean => jobs.some((s) => handedOut(s, lead));

function statusOf(s: SessionRow, say: Say): Pick<TeamRow, 'status' | 'tone' | 'live'> {
  if (s.pending) return { status: say('wisp.crew.job.starting'), tone: 'accent', live: true };
  if (s.state === 'running') return { status: say('wisp.crew.job.working'), tone: 'accent', live: true };
  if (s.state === 'waiting') return { status: say('wisp.crew.job.asking'), tone: 'warn', live: false };
  if (s.status === 'error' || s.status === 'failed' || s.status === 'blocked') return { status: say('wisp.crew.team.failed'), tone: 'bad', live: false };
  if (s.status === 'stopped') return { status: say('wisp.crew.team.stopped'), tone: 'neutral', live: false };
  return { status: say('wisp.crew.team.done'), tone: 'good', live: false };
}

/** The jobs task `lead` (its entity key or id) handed to crew members, oldest first. */
export function teamRows(jobs: readonly SessionRow[], lead: string, memberOf: (id: string) => TeamMember | undefined, say: Say): TeamRow[] {
  return jobs
    .filter((s) => handedOut(s, lead))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((s) => {
      const m = memberOf(s.crew?.id ?? '');
      const name = m?.name ?? '';
      const st = statusOf(s, say);
      const line = (st.live ? s.live : s.preview) || s.title || s.crew?.prompt || '';
      const handle = name ? `@${name}` : say('wisp.crew.team.someone');
      return { id: s.id, member: s.crew?.id ?? '', name, avatar: m?.avatar ?? '', color: m?.color ?? '', handle, line, ...st, pending: !!s.pending };
    });
}
