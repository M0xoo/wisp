// What a job hears (v1 server/crew.js crewNote, kitNote, checkinPrompt, crewJobOf, taggedDelegate):
// appended to its system prompt through runtime.prompt. Who it is, its memory, where this job came
// from and how to hand memory back. Pure.
import { handleOf, JOBS, NOTEBOOK_SOFT, QUIET_JOBS } from '@wisp-plugin/crew-api';
import type { CrewExt, JobKind, Link, LogEntry, Member, TeamRow } from '@wisp-plugin/crew-api';
import { asObj, isObj, str } from './ports.ts';

const LOG_IN_PROMPT = 12;
const LINKS_IN_PROMPT = 8;
const NOTE_MAX = 60_000;
export const WAKE_MIN = 5; // minutes
const ID = /^[a-z0-9]{6,40}$/;

const when = (t: number): string => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const JOB_LABEL: Readonly<Record<string, string>> = { checkin: 'check-in', task: 'from the user', delegated: 'delegated', trigger: 'trigger', mention: 'tagged', event: 'on a task' };
export const EVENT_WHAT: Readonly<Record<string, string>> = { finished: 'just finished', done: 'was marked done by the user' };

type NoteMember = Pick<Member, 'name' | 'role' | 'brief' | 'notebook' | 'cron' | 'kit'>;

/** What a job's note says about the kit. files (a member here): skill name → its SKILL.md on disk. */
export function kitNote(m: Pick<Member, 'kit'>, files: Readonly<Record<string, string>> | null = null): string {
  const kit = (m.kit ?? []).filter((k) => k.on !== false);
  const rules = kit.filter((k) => k.kind === 'rules');
  const skills = kit.filter((k) => k.kind === 'skill');
  let out = '';
  if (rules.length) out += `\n### Your instructions (from the user)\n\nFollow these on every job, as you would an AGENTS.md. Where they differ from the project's own, these win for your work.\n\n${rules.map((r) => `#### ${r.name}\n\n${r.body}`).join('\n\n')}\n`;
  if (!skills.length) return out;
  out += `\n### Your skills\n\nA skill is the user's how-to for one kind of work. When a job fits a skill's description, follow that skill.${files ? ' Read its SKILL.md (with your file-reading tool) before you start on that part.' : ''}\n\n`;
  if (files) out += skills.map((k) => `- **${k.name}**: ${k.description ?? ''} \`${files[k.name] ?? ''}\`${k.path ? ` (its other files are in \`${k.path}\`)` : ''}`).join('\n') + '\n';
  else out += skills.map((k) => `#### Skill: ${k.name}\n\nWhen: ${k.description ?? ''}\n\n${k.body}`).join('\n\n') + '\n';
  return out;
}

const KIT_JOB = `\n\nThe user asked you to build your own kit: the skills and instructions files that make you excellent at the goal in their message. First learn what that takes here: your brief and notebook, your current kit, and (if you have a project) its README, AGENTS.md / CLAUDE.md, design and contributing docs, and how its code is actually written. Then propose files with \`kit\` in your crew block (see below): one instructions file (\`rules\`, e.g. AGENTS.md: how you always work, your standards, what you never do) and a few focused skills (each one kind of work, a description that says exactly when to use it, then concrete steps, checklists, commands and file paths from this project, not generic advice). 2 to 6 files. To improve one you have, propose it under the same name. Don't write them to disk: wisp shows them to the user, who picks what to add. In your report, list each file and why.`;

function thisJob(m: NoteMember, job: Partial<CrewExt>): string {
  const from = job.from?.title ? `"${job.from.title}" (wisp task ${job.from.id})` : 'another task';
  const what: Record<JobKind, string> = {
    checkin: `A check-in${m.cron ? ' on your schedule' : ''}${job.wake ? ', at the time you asked to look again' : ''}. Do your standing job from the brief: find what changed since your last check-in (your notebook has what you saw then), act on it, and report.`,
    task: 'A task from the user, sent to you directly.',
    delegated: `Delegated to you by the agent working on ${from}. That agent reads your report; it can't see your notebook, so say everything it needs.`,
    trigger: `Started by the trigger "${job.from?.title || 'a trigger'}".`,
    mention: `The user tagged you in ${from}. Your answer shows there, under their message. Read that task with wisp_session if you need its context.`,
    event: `The task ${from} ${EVENT_WHAT[job.event ?? ''] ?? 'changed'}, and you watch for that. Do your standing job from the brief on it: read it with wisp_session. To have its agent fix what you found, send it a followUp.`,
  };
  return what[job.job ?? 'task'] + (job.kit ? KIT_JOB : '');
}

function memoryRules(m: NoteMember, job: Partial<CrewExt>, links: readonly Link[]): string {
  const quiet = QUIET_JOBS.has(job.job ?? 'task');
  const followTo = job.job === 'delegated' ? 'not the one that delegated this job: its agent reads your report' : job.from?.id && links.some((l) => l.id === job.from?.id) ? `\`${job.from.id}\` is this job's` : 'none for this job';
  return `### Memory and reporting

Put one \`crew\` block last in your final message's blocks. wisp reads it and doesn't show it to the user:
{"type":"crew","topic":"…","remember":["…"],"notebook":"…","wakeIn":30,"quiet":true,"forLater":true,"followUp":{"task":"<id>","text":"…"}}
- topic: the subject of this job as a short noun phrase (≤6 words), when your answer has no hero to carry one (a quick answer in plain text, then only this block); wisp names the task with it.
- remember: lasting facts to add to your notebook: ids, versions and states you'll compare against next time, the user's preferences for this job, open threads. Other jobs of yours may write at the same time, so add lines with remember rather than rewriting.
- notebook: the whole notebook rewritten, only to tidy it (it has ${m.notebook.length} characters; keep it under ${NOTEBOOK_SOFT}). Drop what's stale.
- wakeIn: minutes until wisp should start a fresh check-in (at least ${WAKE_MIN}), when you want to do your standing job again sooner than your schedule. To carry on with *this* job instead (wait for a deploy or a run, then finish what you started, with this context), call resume_later.
- quiet: ${quiet ? `true when this ${job.job === 'event' ? 'job' : 'check-in'} found nothing the user needs to see: wisp logs it and doesn’t notify them. Leave it out when there is something to report.` : 'only for check-ins and jobs about a task you watch; this job is waited on, so always report.'}
- forLater: ${quiet ? 'true when you found something worth reading but not urgent (a digest, an FYI): wisp files your report in the user’s For later list without notifying them. Leave it out when they should know now, and use quiet when there is nothing to read.' : 'only for check-ins and jobs about a task you watch; this job is waited on, so leave it out.'}
- kit: skills or instructions files you propose for your own kit, when a job asked for that or you found a lasting how-to worth keeping (rarely otherwise): [{"kind":"skill","name":"lowercase-with-dashes","description":"when to use it","body":"markdown steps"},{"kind":"rules","name":"AGENTS.md","body":"markdown"}]. The user reviews them before they're added; the same name replaces yours.
- followUp: a message wisp sends to the agent working on one of your tasks above, as a follow-up from you (the user sees it in that task, from you). Use it when that agent should act on what you found (fix this, rerun that) or was waiting on you. Its task is one of the ids above (${followTo}). wisp adds you to that task's delegates, so its agent can hand the work back to you. At most 3 (a list); only when it helps: your answer already reaches the user.
Leave out the fields you don't need, and keep secrets out of the notebook.`;
}

const logLine = (l: LogEntry): string => `- ${when(l.at)} · ${JOB_LABEL[l.job] ?? l.job} · ${l.title}${l.summary ? `: ${l.summary}` : ''}${l.quiet ? ' (nothing new)' : l.forLater ? ' (filed for later)' : ''}`;

/** Appended to a job's system prompt. log/links: the member's, newest first. */
export function crewNote(m: NoteMember, job: Partial<CrewExt> = {}, files: Readonly<Record<string, string>> | null = null, mem: { log?: readonly LogEntry[]; links?: readonly Link[] } = {}): string {
  const log = (mem.log ?? []).slice(0, LOG_IN_PROMPT);
  const links = mem.links ?? [];
  const part = links.length ? `\n### Tasks you're part of\n\nYou were tagged in or delegated by these. You may send their agent a follow-up (see followUp below):\n${links.slice(0, LINKS_IN_PROMPT).map((l) => `- \`${l.id}\` "${l.title}"`).join('\n')}\n` : '';
  return `

## You are ${m.name}, on the user's crew

${m.role ? `Your role: ${m.role}. ` : ''}You are one of the user's long-lived agents. wisp hands you work as separate jobs: on your schedule (check-ins), from the user, from other tasks' agents, from triggers and when tasks you watch finish or are marked done. Several can run at once, each in its own context. What carries over from job to job is your brief, your notebook and the log below, so keep the notebook current.

### Your brief (from the user)

${m.brief || '(none yet: do what each job asks)'}
${kitNote(m, files)}
### Your notebook

${m.notebook ? `<notebook>\n${m.notebook}\n</notebook>` : 'Empty so far.'}

### Your recent jobs (newest first)

${log.length ? log.map(logLine).join('\n') : 'None yet: this is your first.'}

### This job

${thisJob(m, job)}
${part}
${memoryRules(m, job, links)}`;
}

/** The prompt a check-in starts with. */
export const checkinPrompt = (m: Pick<Member, 'checkins'>, o: { wake?: boolean } = {}): string => `Check-in #${(m.checkins || 0) + 1}${o.wake ? ' (you asked to look again)' : ''}: do your standing job and report what changed.`;

/** A job another wisp sent here for its member (with the note written there). null when it isn't one. */
export function crewJobOf(x: unknown): (CrewExt & { note: string; yours?: true }) | null {
  if (!isObj(x) || !ID.test(str(x['id'])) || typeof x['note'] !== 'string') return null;
  const f = x['from'];
  const from = isObj(f) ? { id: str(f['id']).slice(0, 60), title: str(f['title']).slice(0, 200) } : null;
  const job = (JOBS.has(str(x['job'])) ? str(x['job']) : 'task') as JobKind;
  const event = str(x['event']);
  return {
    id: str(x['id']), job, ...(from && { from }), note: x['note'].slice(0, NOTE_MAX),
    ...(x['wake'] === true && { wake: true }), ...((event === 'finished' || event === 'done') && { event }),
    ...(x['yours'] === true && job === 'task' && { yours: true as const }),
  };
}

/** A member tagged in a task or job, as one of its delegates: the user named them, so bring them in. */
export const taggedDelegate = (m: Pick<Member, 'id' | 'name' | 'role' | 'agent'>, where = 'task'): Record<string, string> => ({
  crew: m.id,
  name: handleOf(m.name),
  label: m.name,
  role: m.role,
  agent: m.agent,
  use: `${m.role ? `${m.role}. ` : ''}The user tagged them in this ${where} to work on it with you: hand them their part rather than doing it all yourself`,
});

/** The delegates a member who followed up joins a task's team as. */
export const followerDelegate = (m: Pick<Member, 'id' | 'name' | 'role' | 'agent'>): Record<string, string> => ({
  crew: m.id, name: handleOf(m.name), label: m.name, role: m.role, agent: m.agent,
  use: `${m.role ? `${m.role}. ` : ''}They followed up in this task: hand your work back to them when it should be checked`,
});

export const teamHas = (team: readonly unknown[], crewId: string): boolean => team.some((t) => asObj(t)['crew'] === crewId);
export type { TeamRow };
