// Crew: named, long-lived agents the user keeps on hand ("Ada · CI watcher"). A member is an
// identity (name, role, avatar), a brief (its standing job), a schedule and a memory. Its work runs
// as ordinary tasks, its jobs (session.crew = { id, job, from?, reply? }), several at once, so each
// job starts with a fresh context and nothing grows without bound. What carries over between jobs
// is the member's memory:
//   brief     the user's: what the job is, how they like it done
//   notebook  the member's own: lasting facts and last-seen state, updated from the hidden `crew`
//             block that ends each job (remember: lines to add, notebook: a full rewrite)
//   log       wisp's: one line per finished job, the newest few go in every job's prompt
// Work reaches a member from its schedule (a check-in: cron, or a wake-up it asked for), the user
// (its page, or @Name in any prompt or follow-up), a lead's `delegate` call, or a trigger: one of
// the GitHub watchers, or a task finishing or marked done (an `event` job, about that task, which
// it may follow up on). The editor's "Also starts when" sets those (`on`, Triggers.syncMember).
// Jobs past the member's `parallel` limit wait in its queue. A check-in (or event job) that found
// nothing says `quiet`: it's logged and archived instead of landing in Needs you.
//
// A member can live on another machine (machine: its id). Its memory, schedule and queue stay
// here; its jobs run there as that wisp's tasks, sent with the member's note (crewJob), and that
// wisp keeps the crew block a job hands back on the turn (crewOut). When a job there finishes,
// this wisp fetches it and files the memory, the log line and any @mention answer (remoteSeen).

import { blocksToMarkdown } from './render.js';
import { cronMatches, nextRun, parseCron, readSchedule } from './triggers.js';
import { adapters } from './adapters/index.js';
import { MAX_SUBAGENTS, normalizeTeam } from './subagents.js';
import { bad, MODES, newId, truncate } from './util.js';
import { KIT_BODY_MAX, KIT_MAX, KIT_TOTAL_MAX, RULES_NAME, SKILL_NAME, parseSkillMd, skillMd, skillName } from '../web/js/skill-md.js';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_CREW = 12;
export const MAX_PARALLEL = 5;
export const BRIEF_MAX = 4000;
export const NOTEBOOK_SOFT = 6000; // what the member is asked to stay under
export const NOTEBOOK_MAX = 12000; // past this the oldest lines go
export const CREW_COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];
export const JOBS = new Set(['checkin', 'task', 'delegated', 'trigger', 'mention', 'event']);
const QUIET_JOBS = new Set(['checkin', 'event']); // jobs nobody waits on: one that found nothing is filed
const LOG_MAX = 40;
const LOG_IN_PROMPT = 12;
const LINKS_MAX = 20;
const LINKS_IN_PROMPT = 8;
const QUEUE_MAX = 20;
const WAKE_MIN = 5; // minutes
const WAKE_MAX = 7 * 24 * 60;
export const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
const PLACE = /^[\w-]{1,40}$/; // a machine id
const NOTE_MAX = 60_000;
const SEEN_MAX = 200;
const OFFERS_MAX = 10;
const OFFER_FILES = 12;
const ID = /^[a-z0-9]{6,40}$/;
// The kept parts of a job's report, for the log, a lead and an @mention's answer.
const KEEP = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tests', 'commits', 'checklist', 'callout', 'question', 'next']);

// A member a spell brings (m.spell = { id, key, name, def }): the spell owns who they are, these
// fields of its blueprint (server/crew-share.js); the rest (project, machine, harness, model,
// effort, how many at once, paused) is yours. A spell changing REVIEWED ones pauses the member
// until you've seen the change (m.changed = { from: the old definition, or null for a new member }).
export const DEFINITION = ['name', 'role', 'avatar', 'color', 'brief', 'cron', 'on', 'mode', 'kit', 'team'];
export const REVIEWED = ['brief', 'kit', 'cron', 'on', 'mode'];

// How a mention of a member is stored in a prompt (the page's prompt boxes make these; a plain
// `@Ada` typed anywhere works too).
export const CREW_MENTION = /@\[([^\]\n]{1,200})\]\(crew:([a-z0-9]{6,40})\)/g;
export const handleOf = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- members ---------------------------------------------------------------------------------

// body → a clean member. prev: the member being edited (its memory and bookkeeping carry on).
// taken: the other members, for unique names.
// machineOk(id): a machine this wisp knows (a member on it runs its jobs there; its cwd is a folder there).
export function normalizeMember(body = {}, prev = null, { taken = [], exists = () => true, machineOk = () => false } = {}) {
  const v = (k, d = '') => (body[k] !== undefined ? body[k] : prev?.[k] !== undefined ? prev[k] : d);
  const name = String(v('name')).replace(/\s+/g, ' ').trim();
  if (!name) throw bad('Give them a name.');
  if (!NAME.test(name)) throw bad('A name is up to 24 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.');
  if (taken.some((m) => m.id !== prev?.id && handleOf(m.name) === handleOf(name))) throw bad(`${name} is already on your crew. Pick another name.`);
  const machine = String(v('machine') || '');
  if (machine && (!PLACE.test(machine) || !machineOk(machine))) throw bad('That machine isn’t one of yours. Add it in Machines first.');
  const cwd = String(v('cwd'));
  if (cwd && !machine && !exists(cwd)) throw bad(`Not a folder on this computer: ${cwd}`);
  const agent = String(v('agent', 'auto')) || 'auto';
  if (agent !== 'auto' && (!adapters[agent] || agent === 'wisp')) throw bad(`Unknown harness: ${agent}`);
  const mode = String(v('mode', 'auto'));
  if (!MODES.has(mode)) throw bad('mode must be plan, edits or auto.');
  const cron = readSchedule(v('cron')); // words ("every monday") or cron
  const color = CREW_COLORS.includes(v('color')) ? v('color') : prev?.color || CREW_COLORS[taken.length % CREW_COLORS.length];
  const notebook = typeof body.notebook === 'string' ? clampNotebook(body.notebook) : prev?.notebook || '';
  return {
    id: prev?.id || newId(),
    name,
    role: String(v('role')).replace(/\s+/g, ' ').trim().slice(0, 60),
    avatar: avatarOf(v('avatar')), // a spirit (web/js/spirit.js), an emoji, or '' (rolled from the name)
    color,
    brief: String(v('brief')).trim().slice(0, BRIEF_MAX),
    cwd,
    machine, // '' = this computer
    agent,
    model: String(v('model')).slice(0, 120),
    effort: /^[\w-]{0,20}$/.test(String(v('effort'))) ? String(v('effort')) : '',
    mode,
    cron,
    parallel: Math.min(MAX_PARALLEL, Math.max(1, Math.floor(Number(v('parallel', 2))) || 2)),
    // Its delegates (like a task's): every job it runs may hand them work. Other crew members
    // count; itself doesn't.
    kit: normalizeKit(body.kit !== undefined ? body.kit : prev?.kit || [], exists),
    team: normalizeTeam((body.team !== undefined ? body.team : prev?.team || []).filter((x) => !prev || x?.crew !== prev.id), adapters),
    paused: v('paused', false) === true,
    notebook,
    // Bookkeeping: what it did and what's next.
    log: prev?.log || [],
    queue: prev?.queue || [],
    away: machine === (prev?.machine || '') ? prev?.away || {} : {}, // jobs running on its machine: { [job id]: { reply? } }
    seen: prev?.seen || [], // turns of its jobs there already filed ("<job id>:<turn count>")
    links: prev?.links || [], // tasks it was tagged in or delegated by, newest first: it may follow up on them
    offers: prev?.offers || [], // skills and instructions its jobs proposed for its kit, for you to pick from
    wakeAt: body.wakeAt === null ? null : prev?.wakeAt || null,
    checkins: prev?.checkins || 0,
    lastCheckinAt: prev?.lastCheckinAt || null,
    lastMinute: cron !== prev?.cron ? null : prev?.lastMinute || null,
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

// A spirit's code ("flame.teal.visor.smile.antenna"), or an emoji of a few code points.
const SPIRIT = /^[a-z]{1,12}(\.[a-z]{1,12}){4}$/;
export const avatarOf = (a) => (SPIRIT.test(String(a || '')) ? String(a) : [...String(a || '').trim()].slice(0, 4).join(''));

// Its kit (web/js/skill-md.js): instructions files it follows on every job, and skills it reads
// when a job fits one's description. A skill imported from this computer keeps its folder (path),
// for the scripts and references beside its SKILL.md.
export function normalizeKit(list, exists = () => true) {
  if (!Array.isArray(list)) throw bad('kit must be a list of files.');
  if (list.length > KIT_MAX) throw bad(`At most ${KIT_MAX} skills and instructions files per member.`);
  const out = [];
  let total = 0;
  for (const x of list) {
    if (!x || typeof x !== 'object') throw bad('Each kit file needs a kind, a name and a body.');
    const kind = x.kind === 'skill' ? 'skill' : x.kind === 'rules' ? 'rules' : null;
    if (!kind) throw bad('A kit file is a skill or an instructions file (kind: skill or rules).');
    const name = String(x.name || '').trim();
    if (kind === 'skill' && !SKILL_NAME.test(name)) throw bad(`A skill’s name is up to 64 lowercase letters, digits and dashes${name ? `, not "${truncate(name, 40)}"` : ''}.`);
    if (kind === 'rules' && !RULES_NAME.test(name)) throw bad('An instructions file’s name is up to 60 letters, digits, spaces, dots or dashes, like AGENTS.md.');
    if (out.some((y) => y.kind === kind && y.name.toLowerCase() === name.toLowerCase())) throw bad(`There are two ${kind === 'skill' ? 'skills' : 'instructions files'} named ${name}.`);
    const description = String(x.description || '').replace(/\s+/g, ' ').trim().slice(0, 1024);
    if (kind === 'skill' && !description) throw bad(`Say when ${name} should be used: that’s how they know to read it.`);
    const body = String(x.body || '').replace(/\r\n/g, '\n').trim();
    if (!body) throw bad(`${name} is empty.`);
    if (body.length > KIT_BODY_MAX) throw bad(`${name} is too long (${body.length.toLocaleString('en')} characters; at most ${KIT_BODY_MAX.toLocaleString('en')}).`);
    total += body.length;
    if (total > KIT_TOTAL_MAX) throw bad(`Their skills and instructions add up to more than ${KIT_TOTAL_MAX.toLocaleString('en')} characters. Trim or remove some.`);
    const dir = kind === 'skill' && typeof x.path === 'string' && path.isAbsolute(x.path) && x.path.length < 500 && exists(x.path) ? x.path : '';
    out.push({ id: ID.test(x.id || '') ? x.id : newId(), kind, name, ...(kind === 'skill' && { description }), body, ...(dir && { path: dir }), on: x.on !== false });
  }
  return out;
}

// The files a job proposed (its crew block's kit) that would pass as kit files: each checked on
// its own, so one bad file doesn't lose the rest. A skill's name is made fit (Release Notes → release-notes).
export function offerFiles(list = []) {
  const out = [];
  for (const x of list.slice(0, OFFER_FILES)) {
    const kind = x.kind === 'rules' || x.kind === 'instructions' ? 'rules' : 'skill';
    try {
      const [k] = normalizeKit([{ ...x, kind, name: kind === 'skill' ? skillName(x.name) : String(x.name || 'AGENTS.md').replace(/[^\w .-]/g, '').trim() }]);
      if (!out.some((y) => y.kind === k.kind && y.name.toLowerCase() === k.name.toLowerCase())) out.push((({ id, on, path: _, ...rest }) => rest)(k));
    } catch {}
  }
  return out;
}

// What a job's note says about the kit. files (a member here): skill name → its SKILL.md on disk,
// read when needed. Without them (a job on another machine) the skills are written out in full.
function kitNote(m, files = null) {
  const kit = (m.kit || []).filter((k) => k.on !== false);
  const rules = kit.filter((k) => k.kind === 'rules');
  const skills = kit.filter((k) => k.kind === 'skill');
  let out = '';
  if (rules.length) out += `\n### Your instructions (from the user)\n\nFollow these on every job, as you would an AGENTS.md. Where they differ from the project's own, these win for your work.\n\n${rules.map((r) => `#### ${r.name}\n\n${r.body}`).join('\n\n')}\n`;
  if (!skills.length) return out;
  out += `\n### Your skills\n\nA skill is the user's how-to for one kind of work. When a job fits a skill's description, follow that skill.${files ? ' Read its SKILL.md (with your file-reading tool) before you start on that part.' : ''}\n\n`;
  if (files) out += skills.map((k) => `- **${k.name}**: ${k.description} \`${files[k.name]}\`${k.path ? ` (its other files are in \`${k.path}\`)` : ''}`).join('\n') + '\n';
  else out += skills.map((k) => `#### Skill: ${k.name}\n\nWhen: ${k.description}\n\n${k.body}`).join('\n\n') + '\n';
  return out;
}

// Skills and instructions files already on this computer, to add to a kit: the harnesses' own
// (~/.claude/skills, ~/.codex/AGENTS.md, …) and a project's (cwd). { skills, rules }, each with
// where it came from (from) and its text.
const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.codex/skills', '.gemini/skills'];
const RULES_FILES = ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md'];
const PROJECT_RULES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
export function localKit({ home, cwd = '' }) {
  const roots = [{ dir: home, label: '~', rules: RULES_FILES }, ...(cwd && cwd !== home ? [{ dir: cwd, label: path.basename(cwd), rules: PROJECT_RULES }] : [])];
  const read = (f) => {
    try {
      const st = fs.statSync(f);
      return st.isFile() && st.size <= KIT_BODY_MAX * 2 ? fs.readFileSync(f, 'utf8') : null;
    } catch {
      return null;
    }
  };
  const skills = [];
  const rules = [];
  for (const r of roots) {
    for (const rel of r.rules) {
      const text = read(path.join(r.dir, rel));
      if (text?.trim()) rules.push({ name: path.basename(rel), from: `${r.label}/${rel}`, body: text.trim().slice(0, KIT_BODY_MAX) });
    }
    for (const rel of SKILL_DIRS) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(path.join(r.dir, rel), { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink());
      } catch {}
      for (const d of dirs) {
        const dir = path.join(r.dir, rel, d.name);
        const text = read(path.join(dir, 'SKILL.md'));
        if (!text) continue;
        const sk = parseSkillMd(text);
        const name = skillName(sk.name || d.name);
        if (!name || !sk.body || skills.some((x) => x.name === name)) continue;
        let files = 0;
        try {
          files = fs.readdirSync(dir).filter((f) => f !== 'SKILL.md' && !f.startsWith('.')).length;
        } catch {}
        skills.push({ name, description: sk.description, body: sk.body.slice(0, KIT_BODY_MAX), from: `${r.label}/${rel}/${d.name}`, ...(files && { path: dir, files }) });
        if (skills.length >= 100) break;
      }
    }
  }
  return { skills, rules };
}

export function clampNotebook(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  // Over the cap: the oldest lines go first (new facts are appended at the end).
  while (t.length > NOTEBOOK_MAX && t.includes('\n')) t = t.slice(t.indexOf('\n') + 1);
  return t.slice(-NOTEBOOK_MAX);
}

// When the member's next check-in is due: its schedule or a wake-up it asked for. null: none.
export function nextCheckin(m, now = Date.now()) {
  if (m.paused) return null;
  let at = null;
  if (m.cron) {
    try {
      const c = parseCron(m.cron);
      at = nextRun(c, now - 60_000); // this minute counts, unless it already ran in it
      if (at && Math.floor(at / 60_000) === m.lastMinute) at = nextRun(c, at);
    } catch {}
  }
  if (m.wakeAt && (!at || m.wakeAt < at)) at = m.wakeAt;
  return at;
}

// Whether a check-in is due this minute (once per minute for a cron, once for a wake-up).
export function dueNow(m, now = Date.now()) {
  if (m.paused) return false;
  if (m.wakeAt && m.wakeAt <= now) return true;
  if (!m.cron || m.lastMinute === Math.floor(now / 60_000)) return false;
  try {
    return cronMatches(parseCron(m.cron), new Date(now));
  } catch {
    return false;
  }
}

// --- what a job hears --------------------------------------------------------------------------

const when = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const JOB_LABEL = { checkin: 'check-in', task: 'from the user', delegated: 'delegated', trigger: 'trigger', mention: 'tagged', event: 'on a task' };
const EVENT_WHAT = { finished: 'just finished', done: 'was marked done by the user' };

// Appended to a job's system prompt: who it is, its memory, where this job came from and how to
// hand memory back.
export function crewNote(m, job = {}, files = null) {
  const log = (m.log || []).slice(0, LOG_IN_PROMPT);
  const from = job.from?.title ? `"${job.from.title}" (wisp task ${job.from.id})` : 'another task';
  const what = {
    checkin: `A check-in${m.cron ? ' on your schedule' : ''}${job.wake ? ', at the time you asked to look again' : ''}. Do your standing job from the brief: find what changed since your last check-in (your notebook has what you saw then), act on it, and report.`,
    task: 'A task from the user, sent to you directly.',
    delegated: `Delegated to you by the agent working on ${from}. That agent reads your report; it can't see your notebook, so say everything it needs.`,
    trigger: `Started by the trigger "${job.from?.title || 'a trigger'}".`,
    mention: `The user tagged you in ${from}. Your answer shows there, under their message. Read that task with wisp_session if you need its context.`,
    event: `The task ${from} ${EVENT_WHAT[job.event] || 'changed'}, and you watch for that. Do your standing job from the brief on it: read it with wisp_session. To have its agent fix what you found, send it a followUp.`,
  }[job.job || 'task'] + (job.kit ? `\n\nThe user asked you to build your own kit: the skills and instructions files that make you excellent at the goal in their message. First learn what that takes here: your brief and notebook, your current kit, and (if you have a project) its README, AGENTS.md / CLAUDE.md, design and contributing docs, and how its code is actually written. Then propose files with \`kit\` in your crew block (see below): one instructions file (\`rules\`, e.g. AGENTS.md: how you always work, your standards, what you never do) and a few focused skills (each one kind of work, a description that says exactly when to use it, then concrete steps, checklists, commands and file paths from this project, not generic advice). 2 to 6 files. To improve one you have, propose it under the same name. Don't write them to disk: wisp shows them to the user, who picks what to add. In your report, list each file and why.` : '');
  return `

## You are ${m.name}, on the user's crew

${m.role ? `Your role: ${m.role}. ` : ''}You are one of the user's long-lived agents. wisp hands you work as separate jobs: on your schedule (check-ins), from the user, from other tasks' agents, from triggers and when tasks you watch finish or are marked done. Several can run at once, each in its own context. What carries over from job to job is your brief, your notebook and the log below, so keep the notebook current.

### Your brief (from the user)

${m.brief || '(none yet: do what each job asks)'}
${kitNote(m, files)}
### Your notebook

${m.notebook ? `<notebook>\n${m.notebook}\n</notebook>` : 'Empty so far.'}

### Your recent jobs (newest first)

${log.length ? log.map((l) => `- ${when(l.at)} · ${JOB_LABEL[l.job] || l.job} · ${l.title}${l.summary ? `: ${l.summary}` : ''}${l.quiet ? ' (nothing new)' : l.forLater ? ' (filed for later)' : ''}`).join('\n') : 'None yet: this is your first.'}

### This job

${what}
${(m.links || []).length ? `\n### Tasks you're part of\n\nYou were tagged in or delegated by these. You may send their agent a follow-up (see followUp below):\n${m.links.slice(0, LINKS_IN_PROMPT).map((l) => `- \`${l.id}\` "${l.title}"`).join('\n')}\n` : ''}
### Memory and reporting

Put one \`crew\` block last in your final message's blocks. wisp reads it and doesn't show it to the user:
{"type":"crew","remember":["…"],"notebook":"…","wakeIn":30,"quiet":true,"forLater":true,"followUp":{"task":"<id>","text":"…"}}
- remember: lasting facts to add to your notebook: ids, versions and states you'll compare against next time, the user's preferences for this job, open threads. Other jobs of yours may write at the same time, so add lines with remember rather than rewriting.
- notebook: the whole notebook rewritten, only to tidy it (it has ${m.notebook.length} characters; keep it under ${NOTEBOOK_SOFT}). Drop what's stale.
- wakeIn: minutes until wisp should start a fresh check-in (at least ${WAKE_MIN}), when you want to do your standing job again sooner than your schedule. To carry on with *this* job instead (wait for a deploy or a run, then finish what you started, with this context), call resume_later.
- quiet: ${QUIET_JOBS.has(job.job) ? `true when this ${job.job === 'event' ? 'job' : 'check-in'} found nothing the user needs to see: wisp logs it and doesn’t notify them. Leave it out when there is something to report.` : 'only for check-ins and jobs about a task you watch; this job is waited on, so always report.'}
- forLater: ${QUIET_JOBS.has(job.job) ? 'true when you found something worth reading but not urgent (a digest, an FYI): wisp files your report in the user’s For later list without notifying them. Leave it out when they should know now, and use quiet when there is nothing to read.' : 'only for check-ins and jobs about a task you watch; this job is waited on, so leave it out.'}
- kit: skills or instructions files you propose for your own kit, when a job asked for that or you found a lasting how-to worth keeping (rarely otherwise): [{"kind":"skill","name":"lowercase-with-dashes","description":"when to use it","body":"markdown steps"},{"kind":"rules","name":"AGENTS.md","body":"markdown"}]. The user reviews them before they're added; the same name replaces yours.
- followUp: a message wisp sends to the agent working on one of your tasks above, as a follow-up from you (the user sees it in that task, from you). Use it when that agent should act on what you found (fix this, rerun that) or was waiting on you. Its task is one of the ids above (${job.job === 'delegated' ? 'not the one that delegated this job: its agent reads your report' : job.from?.id && (m.links || []).some((l) => l.id === job.from.id) ? `\`${job.from.id}\` is this job's` : 'none for this job'}). wisp adds you to that task's delegates, so its agent can hand the work back to you. At most 3 (a list); only when it helps: your answer already reaches the user.
Leave out the fields you don't need, and keep secrets out of the notebook.`;
}

// A job another wisp sent here for its crew member (crewJob on POST /sessions): which member,
// what kind of job, and the member's note, made there from its memory. null when it isn't one.
export function crewJobOf(x) {
  if (!x || typeof x !== 'object' || !ID.test(x.id || '') || typeof x.note !== 'string') return null;
  const from = x.from && typeof x.from === 'object' ? { id: String(x.from.id || '').slice(0, 60), title: String(x.from.title || '').slice(0, 200) } : null;
  return { id: x.id, job: JOBS.has(x.job) ? x.job : 'task', ...(from && { from }), note: x.note.slice(0, NOTE_MAX), ...(x.wake === true && { wake: true }), ...(EVENT_WHAT[x.event] && { event: x.event }) };
}

// The prompt a check-in starts with.
export const checkinPrompt = (m, { wake = false } = {}) => `Check-in #${(m.checkins || 0) + 1}${wake ? ' (you asked to look again)' : ''}: do your standing job and report what changed.`;

// --- what a job hands back -----------------------------------------------------------------------

// Takes the `crew` blocks out of a presentation: { remember, notebook, wakeIn, quiet, forLater } (merged).
export function takeCrewBlock(presentation) {
  const blocks = presentation?.blocks || [];
  const mine = blocks.filter((b) => b?.type === 'crew');
  if (!mine.length) return null;
  presentation.blocks = blocks.filter((b) => b?.type !== 'crew');
  const out = { remember: [] };
  for (const b of mine) {
    if (Array.isArray(b.remember)) out.remember.push(...b.remember.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 300)));
    else if (typeof b.remember === 'string' && b.remember.trim()) out.remember.push(b.remember.trim().slice(0, 300));
    if (typeof b.notebook === 'string') out.notebook = b.notebook;
    if (Number(b.wakeIn) > 0) out.wakeIn = Number(b.wakeIn);
    if (b.quiet === true) out.quiet = true;
    if (b.forLater === true) out.forLater = true;
    if (Array.isArray(b.kit))
      for (const k of b.kit) if (k && typeof k === 'object') (out.kit ||= []).push({ kind: String(k.kind || ''), name: String(k.name || '').trim().slice(0, 64), description: String(k.description || '').slice(0, 1024), body: String(k.body || '').slice(0, KIT_BODY_MAX) });
    for (const f of [b.followUp].flat())
      if (f && typeof f === 'object' && typeof f.text === 'string' && f.text.trim()) (out.followUps ||= []).push({ task: String(f.task || '').slice(0, 60), text: f.text.trim().slice(0, 4000) });
  }
  out.remember = out.remember.slice(0, 12);
  if (out.followUps) out.followUps = out.followUps.slice(0, 3);
  if (out.kit) out.kit = out.kit.slice(0, OFFER_FILES);
  if (!presentation.blocks.length) presentation.blocks = [{ type: 'hero', title: 'Nothing new', summary: '', status: 'info' }];
  return out;
}

// What changes on the member: its notebook and its next wake-up.
export function applyMemory(m, data, now = Date.now()) {
  if (!data) return;
  if (typeof data.notebook === 'string') m.notebook = clampNotebook(data.notebook);
  if (data.remember?.length) m.notebook = clampNotebook([m.notebook, ...data.remember.map((x) => `- ${x}`)].filter(Boolean).join('\n'));
  if (data.wakeIn) m.wakeAt = now + Math.min(WAKE_MAX, Math.max(WAKE_MIN, Math.round(data.wakeIn))) * 60_000;
}

const heroOf = (turn) => turn?.presentation?.blocks?.find((b) => b?.type === 'hero');

// One line in the member's log for a finished job.
export function logEntry(session, turn, { quiet = false } = {}) {
  const hero = heroOf(turn);
  const status = turn.status === 'done' ? hero?.status || 'done' : turn.status === 'stopped' ? 'partial' : 'blocked';
  return {
    at: turn.endedAt || Date.now(),
    job: session.crew?.job || 'task',
    title: truncate(hero?.title || (turn.status === 'error' ? 'Failed' : turn.status === 'stopped' ? 'Stopped' : 'Finished'), 80),
    summary: truncate(String(hero?.summary || '').replace(/\s+/g, ' '), 160),
    prompt: truncate(plainCrew(turn.prompt || '').replace(/\s+/g, ' ').trim(), 200), // what it was asked
    ...(session.crew?.from?.title && { from: session.crew.from }),
    status,
    ...(quiet && { quiet: true }),
    ...(session.forLater?.by === 'crew' && { forLater: true }), // filed in the user's For later
    sessionId: session.id,
  };
}

// A job's report as markdown, for an @mention's answer.
export const reportText = (turn) => truncate(blocksToMarkdown((turn?.presentation?.blocks || []).filter((b) => KEEP.has(b?.type)), turn).trim(), 6000);

// --- mentions --------------------------------------------------------------------------------------

// The members a text names: `@[Ada](crew:<id>)` (the page's form) or a plain `@Ada` / `@ada`.
// lead: the text starts with it, i.e. it's addressed to them. rest: the text without the leading mentions.
export function crewMentions(text = '', members = []) {
  const src = String(text);
  const hits = new Map();
  for (const x of src.matchAll(CREW_MENTION)) {
    const m = members.find((y) => y.id === x[2]);
    if (m && !hits.has(m.id)) hits.set(m.id, { member: m, at: x.index, len: x[0].length });
  }
  // Plain @names: the longest first, so "@Ada Lovelace" isn't read as "@Ada".
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    if (hits.has(m.id)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@\\]])@(${escRe(m.name)}|${escRe(handleOf(m.name))})(?![\\p{L}\\p{N}_-])`, 'iu');
    const x = re.exec(src.replace(CREW_MENTION, (s) => ' '.repeat(s.length)));
    if (x) hits.set(m.id, { member: m, at: x.index + x[1].length, len: x[0].length - x[1].length });
  }
  const list = [...hits.values()].sort((a, b) => a.at - b.at);
  // Leading: mentions with nothing but spaces and commas before them.
  let at = src.match(/^\s*/)[0].length;
  const lead = [];
  for (const h of list) {
    if (h.at !== at) break;
    lead.push(h.member);
    at = h.at + h.len;
    at += src.slice(at).match(/^[\s,:]*/)[0].length;
  }
  return { all: list.map((h) => h.member), lead, rest: lead.length ? src.slice(at).trim() : src };
}

// A member tagged in a task or job, as one of its delegates. The user named them, so the agent is
// told to bring them in rather than leave it to its own judgement.
export const taggedDelegate = (m, where = 'task') => ({
  crew: m.id,
  name: handleOf(m.name),
  label: m.name,
  role: m.role,
  agent: m.agent,
  use: `${m.role ? `${m.role}. ` : ''}The user tagged them in this ${where} to work on it with you: hand them their part rather than doing it all yourself`,
});

// Stored crew mentions as an agent or a person reads them: `@Ada`.
export const plainCrew = (text = '') => String(text).replace(CREW_MENTION, '@$1');

// --- the service -----------------------------------------------------------------------------------

// launch(body, origin, { crew }) starts a job like POST /api/sessions; onChange() after changes.
export class Crew {
  // remote (members on machines): { ok(mid), launch(body, origin) → [summary], jobs(m) → the
  // member's job summaries there, fetch(id) → a job's full session }, ids qualified (`id@machine`).
  // followUp(task, text): a follow-up on a task, as the user would send it (services/launch.js replyTo).
  constructor({ store, runner, launch, remote = null, followUp = null, onChange = () => {}, exists = () => true, now = () => Date.now() }) {
    Object.assign(this, { store, runner, launch, remote, followUp, onChange, exists, now });
    store.config.crew ||= [];
    for (const m of store.config.crew) Object.assign(m, { away: m.away || {}, seen: m.seen || [], links: m.links || [], machine: m.machine || '' }); // members from before these
    this.starting = new Map(); // member id -> jobs being launched (not sessions yet)
    this.fetched = new Map(); // job id there -> its full session, as last fetched (a lead's delegation reads it)
    this.filing = new Set(); // "<job id>:<turn count>" being fetched and filed now
    // A job here for a member of another wisp carries its note; a member of ours, we write it.
    runner.crewNote = (s) => {
      const m = this.get(s.crew?.id);
      return m ? crewNote(m, s.crew, m.machine ? null : this.kitFiles(m)) : s.crew?.note || '';
    };
    // Its skills' folders, readable by the job (a harness that limits reads to its folders).
    runner.crewDirs = (s) => {
      const m = this.get(s.crew?.id);
      const files = m && !m.machine ? this.kitFiles(m) : null;
      if (!files) return [];
      return [...new Set((m.kit || []).filter((k) => k.kind === 'skill' && k.on !== false).flatMap((k) => [path.dirname(files[k.name]), k.path || []].flat()))];
    };
    runner.crewChild = (id) => this.fetched.get(id) || null;
    runner.crewTurn = (s, turn) => this.#turnDone(s, turn);
    runner.crewDelegate = (lead, member, prompt) => this.#delegate(lead, member, prompt);
    runner.on('ended', (e) => this.#ended(e));
  }

  get list() {
    return this.store.config.crew;
  }

  get(id) {
    return this.list.find((m) => m.id === id) || null;
  }

  find(key) {
    const k = String(key || '');
    return this.get(k) || this.list.find((m) => handleOf(m.name) === handleOf(k)) || null;
  }

  // A member as the page and the API see it: its jobs running and what's next.
  view(m) {
    const jobs = this.jobs(m);
    return { ...m, running: jobs.filter((s) => s.state === 'running' || s.state === 'waiting').length + (this.starting.get(m.id) || 0), jobs: jobs.length, nextAt: nextCheckin(m, this.now()), handle: handleOf(m.name), on: this.on(m) };
  }

  // What else starts its jobs: the kinds of the triggers that are on and send it work.
  on(m) {
    return [...new Set((this.store.config.triggers || []).filter((t) => t.crew === m.id && t.enabled).map((t) => t.kind))];
  }

  // Its jobs: tasks here, or (a member on a machine) the summaries of its tasks there.
  jobs(m) {
    return [...this.store.all().filter((s) => s.crew?.id === m.id), ...(m.machine && this.remote ? this.remote.jobs(m) : [])];
  }

  busy(m) {
    return this.jobs(m).filter((s) => s.state === 'running' || s.state === 'waiting').length + (this.starting.get(m.id) || 0);
  }

  // Writes the member's skills out as SKILL.md files (<home>/crew/<id>/skills/<name>/) for a job
  // to read, dropping ones it no longer has. Returns name → file, or null without a home (a stub).
  kitFiles(m) {
    if (!this.store.home) return null;
    const root = path.join(this.store.home, 'crew', m.id, 'skills');
    const skills = (m.kit || []).filter((k) => k.kind === 'skill' && k.on !== false);
    const files = {};
    try {
      fs.mkdirSync(root, { recursive: true });
      for (const d of fs.readdirSync(root)) if (!skills.some((k) => k.name === d)) fs.rmSync(path.join(root, d), { recursive: true, force: true });
      for (const k of skills) {
        const file = path.join(root, k.name, 'SKILL.md');
        const text = skillMd(k);
        if ((fs.existsSync(file) && fs.readFileSync(file, 'utf8')) !== text) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, text);
        }
        files[k.name] = file;
      }
    } catch (err) {
      console.warn(`wisp: crew skills for ${m.name}: ${err.message}`);
      return null;
    }
    return files;
  }

  #norm(body, prev) {
    return normalizeMember(body, prev, { taken: this.list, exists: this.exists, machineOk: (id) => !!this.remote?.ok(id) });
  }

  create(body) {
    if (this.list.length >= MAX_CREW) throw bad(`Your crew is full (${MAX_CREW}). Remove someone first.`);
    const m = this.#norm(body, null);
    this.list.push(m);
    this.#changed();
    return m;
  }

  // bySpell: the spell applying its blueprint (server/crew-share.js), past the lock on what it owns.
  update(m, body, { bySpell = false } = {}) {
    const wasPaused = m.paused;
    if (m.spell && !bySpell) {
      const owned = DEFINITION.filter((k) => k !== 'on' && body[k] !== undefined && JSON.stringify(body[k]) !== JSON.stringify(m[k]));
      if (owned.length) throw bad(`${m.name} comes from the “${m.spell.name}” spell, which sets their ${owned.join(', ')}. Make them yours first (Make it mine).`, 409);
    }
    // A member whose spell changed what they do resumes only once you've seen the change.
    if (m.changed && m.paused && body.paused === false && !bySpell) {
      if (body.accept !== true) throw bad(`${m.spell ? `The “${m.spell.name}” spell` : 'Their spell'} changed what ${m.name} does: review it before they resume.`, 409);
      delete m.changed;
    }
    Object.assign(m, this.#norm(body, m));
    this.#changed();
    if (wasPaused && !m.paused) this.drain(m);
    return m;
  }

  // Leaves the crew. Its jobs stay as ordinary tasks; triggers that sent it work stop.
  remove(m) {
    this.store.config.crew = this.list.filter((x) => x !== m);
    for (const x of this.list) x.team = (x.team || []).filter((t) => t.crew !== m.id);
    for (const t of this.store.config.triggers || []) if (t.crew === m.id) Object.assign(t, { crew: '', enabled: false, lastError: `${m.name} left your crew.` });
    if (this.store.home) fs.rmSync(path.join(this.store.home, 'crew', m.id), { recursive: true, force: true });
    this.#changed();
  }

  // An existing task joins the crew: its folder, harness and model become the member's, its first
  // prompt the brief (unless one is given), and the task becomes the member's first job.
  adopt(s, body = {}) {
    const root = this.store.projectFor?.(s.cwd)?.path || (this.store.isScratch?.(s.cwd) ? '' : s.cwd);
    const m = this.create({ cwd: root, agent: s.agent, model: s.model, effort: s.effort, mode: s.mode, brief: s.turns[0]?.prompt ? plainCrew(s.turns[0].prompt) : '', ...body });
    s.crew = { id: m.id, job: 'task' };
    this.store.save(s);
    return m;
  }

  // Hand the member a job. Past its parallel limit (or while paused, for anything but your own
  // tasks) it waits in the member's queue. Resolves with { session } or { queued }.
  // tagged: crew members named in the prompt (@Quill), who join this job's delegates.
  // kit: the job builds the member's kit (it proposes files; you pick).
  // event: what a task watcher saw happen to `from` (finished, done).
  async assign(m, { prompt, job = 'task', from = null, origin = null, attachments = [], reply = null, wake = false, tagged = [], kit = false, event = '' } = {}) {
    if (!JOBS.has(job)) job = 'task';
    const text = String(prompt || '').trim() || (job === 'checkin' ? checkinPrompt(m, { wake }) : '');
    if (!text) throw bad('Tell them what to do.');
    const extra = tagged.filter((x) => x.id !== m.id).map((x) => taggedDelegate(x, 'job'));
    const w = { id: newId(), prompt: text, job, ...(from && { from }), ...(origin && { origin }), ...(attachments.length && { attachments }), ...(reply && { reply }), ...(wake && { wake: true }), ...(EVENT_WHAT[event] && { event }), ...(kit && { kit: true }), ...(extra.length && { team: extra }), at: this.now() };
    if (from?.id && (job === 'mention' || job === 'delegated' || job === 'event')) this.#link(m, from);
    if (this.busy(m) >= m.parallel || (m.paused && job !== 'task' && job !== 'mention')) {
      if (m.queue.length >= QUEUE_MAX) throw bad(`${m.name} already has ${QUEUE_MAX} jobs waiting.`, 429);
      m.queue.push(w);
      this.#changed();
      return { queued: m.queue.length };
    }
    return { session: await this.#start(m, w) };
  }

  async #start(m, w) {
    this.starting.set(m.id, (this.starting.get(m.id) || 0) + 1);
    try {
      if (w.job === 'checkin') Object.assign(m, { checkins: (m.checkins || 0) + 1, lastCheckinAt: this.now() });
      const crew = { id: m.id, job: w.job, ...(w.from && { from: w.from }), ...(w.reply && { reply: w.reply }), ...(w.wake && { wake: true }), ...(w.event && { event: w.event }), ...(w.kit && { kit: true }) };
      const body = { prompt: w.prompt, ...(m.cwd ? { cwd: m.cwd } : { scratch: true }), agent: m.agent, model: m.model || undefined, effort: m.effort || undefined, mode: m.mode, attachments: w.attachments || [], ...this.#teamFor(m, w.job, w.team) };
      if (m.machine) return await this.#startAway(m, body, crew, w.origin);
      const [s] = await this.launch(body, w.origin || null, { crew });
      return s;
    } finally {
      this.starting.set(m.id, this.starting.get(m.id) - 1);
      this.#changed();
    }
  }

  // A job on the member's machine: that wisp runs it with the note we write from the member's
  // memory, and we remember what to do when it's done (an @mention's answer). Resolves with its summary.
  async #startAway(m, body, crew, origin = null) {
    if (!this.remote) throw bad('Machines aren’t available here.');
    const { reply, ...sent } = crew;
    const [s] = await this.remote.launch({ ...body, machine: m.machine, crewJob: { ...sent, note: crewNote(m, crew) } }, origin);
    m.away[s.id] = { ...(reply && { reply }), at: this.now() };
    return s;
  }

  // The delegates a job of the member gets. A delegated job hands nothing on to the crew (no
  // loops between members), and one on a machine can't reach the crew here.
  #teamFor(m, job, extra = []) {
    const mine = [...(m.team || []), ...extra.filter((x) => !(m.team || []).some((t) => t.crew === x.crew))];
    const team = normalizeTeam(mine.filter((x) => x.crew !== m.id && !(x.crew && (job === 'delegated' || m.machine))), adapters);
    return team.length ? { subagents: team } : {};
  }

  // Files a job proposed for the member's kit: kept on the member until you add or dismiss them
  // (its thread shows them under that job). A follow-up on the job replaces its earlier offer.
  #offer(m, s, list) {
    const files = offerFiles(list);
    if (!files.length) return;
    const offer = { id: newId(), job: s.id, at: this.now(), files, state: 'open' };
    m.offers = [offer, ...(m.offers || []).filter((o) => o.job !== s.id)].slice(0, OFFERS_MAX);
  }

  // Files an agent proposed for the member's kit from a task (wisp_crew_kit): an offer that task
  // shows under the turn that made it. A second call in the same turn adds to that offer (the same
  // name replaces). Each file is checked on its own; refused ones come back with why.
  propose(m, s, list = []) {
    const turn = s.turns?.at(-1)?.id || '';
    const files = [];
    const refused = [];
    for (const x of (Array.isArray(list) ? list : []).slice(0, OFFER_FILES)) {
      const kind = x?.kind === 'rules' || x?.kind === 'instructions' ? 'rules' : 'skill';
      const name = kind === 'skill' ? skillName(x?.name) : String(x?.name || 'AGENTS.md').replace(/[^\w .-]/g, '').trim();
      try {
        const [k] = normalizeKit([{ kind, name, description: String(x?.description || '').slice(0, 1024), body: String(x?.body || '').slice(0, KIT_BODY_MAX) }]);
        files.push((({ id, on, path: _, ...rest }) => rest)(k));
      } catch (err) {
        refused.push(`${name || x?.name || 'a file'}: ${err.message}`);
      }
    }
    if (!files.length) throw bad(refused.length ? `None of those could join ${m.name}’s kit. ${refused.join(' ')}` : 'Give at least one file to propose.');
    const prev = (m.offers || []).find((o) => o.job === s.id && o.turn === turn && o.state === 'open');
    const merged = [...(prev?.files || []).filter((f) => !files.some((y) => y.kind === f.kind && y.name.toLowerCase() === f.name.toLowerCase())), ...files].slice(-OFFER_FILES);
    const offer = { id: prev?.id || newId(), job: s.id, turn, at: this.now(), files: merged, state: 'open' };
    m.offers = [offer, ...(m.offers || []).filter((o) => o.id !== offer.id)].slice(0, OFFERS_MAX);
    this.#changed();
    return { offer, refused };
  }

  // You added (taken: the names added) or dismissed an offer.
  settleOffer(m, id, { state, names = [] }) {
    const o = (m.offers || []).find((x) => x.id === id);
    if (!o || !['taken', 'dismissed'].includes(state)) return;
    Object.assign(o, { state, names: names.filter((n) => typeof n === 'string').map((n) => n.slice(0, 64)).slice(0, OFFER_FILES), settledAt: this.now() });
    this.#changed();
  }

  // A task that tagged or delegated to the member: it may follow up there later (newest first).
  #link(m, from) {
    m.links = [{ id: from.id, title: from.title || '', at: this.now() }, ...(m.links || []).filter((l) => l.id !== from.id)].slice(0, LINKS_MAX);
  }

  // The follow-ups a job asked for, each to a task the member is linked to, as a message from it.
  #sendFollowUps(m, s, list = []) {
    for (const f of list) {
      const id = f.task || s.crew?.from?.id;
      // A delegated job's lead already reads its report: a follow-up there says it twice, and the
      // two could bounce work back and forth.
      if (s.crew?.job === 'delegated' && id === s.crew.from?.id) continue;
      const task = (m.links || []).some((l) => l.id === id) && this.store.get(id);
      if (!task || !this.followUp) continue;
      const text = `@[${m.name}](crew:${m.id}) (your crew${m.role ? `’s ${m.role}` : ''}):\n\n${f.text}`;
      Promise.resolve(this.followUp(task, text, { team: this.#joinTeam(task, m) })).catch((err) => console.warn(`wisp: crew follow-up: ${err.message}`));
      // The job says where it followed up (its thread shows it); one on another machine can't be marked.
      const job = this.store.get(s.id);
      if (job?.crew && !job.crew.sent?.some((x) => x.id === task.id)) {
        (job.crew.sent ||= []).push({ id: task.id, title: task.title });
        this.runner.refresh?.(job);
      }
    }
  }

  // A member that follows up on a task joins its delegates, so its agent can hand the work back
  // (check my fix). Not a subagent's or a delegated job's (no loops), nor past a full team.
  #joinTeam(task, m) {
    const have = task.subagents || [];
    if (task.parentId || task.delegated || task.crew?.job === 'delegated' || task.crew?.id === m.id) return undefined;
    if (have.some((x) => x.crew === m.id) || have.length >= MAX_SUBAGENTS) return undefined;
    const use = `${m.role ? `${m.role}. ` : ''}They followed up in this task: hand your work back to them when it should be checked`;
    try {
      return normalizeTeam([...have, { crew: m.id, name: handleOf(m.name), label: m.name, role: m.role, agent: m.agent, use }], adapters);
    } catch {
      return undefined; // too many copies in all: the follow-up still goes, without them
    }
  }

  // You follow up on a member's answer in a task: the same job carries on (it remembers the
  // thread), and its answer lands under yours. Resolves with the new entry.
  async replyIn(task, entryId, text) {
    const turn = task.turns.find((t) => t.btw?.some((b) => b.id === entryId));
    const parent = turn?.btw.find((b) => b.id === entryId);
    const m = this.get(parent?.crew?.id);
    if (!m) throw bad('They’re no longer on your crew.', 404);
    if (!parent.job) throw bad(`${m.name} hasn’t started on it yet.`, 409);
    const entry = { id: newId(), question: text, status: 'running', askedAt: this.now(), crew: parent.crew, job: parent.job, thread: parent.thread || parent.id };
    // Right after the thread it continues, so it reads as one conversation.
    let at = turn.btw.indexOf(parent);
    while (turn.btw[at + 1]?.thread === entry.thread) at++;
    turn.btw.splice(at + 1, 0, entry);
    this.runner.sideChanged(task, turn);
    const reply = { sessionId: task.id, turnId: turn.id, entryId: entry.id };
    try {
      const job = this.store.get(parent.job);
      if (job) {
        job.crew.reply = reply;
        await this.followUp(job, text, { queue: true });
      } else {
        if (!m.machine || !this.remote?.reply) throw bad('That job is gone.', 404);
        m.away[parent.job] = { reply, at: this.now() };
        await this.remote.reply(parent.job, text);
      }
      this.#changed();
      return entry;
    } catch (err) {
      Object.assign(entry, { status: 'error', error: err.message, answeredAt: this.now() });
      this.runner.sideChanged(task, turn);
      throw err;
    }
  }

  // Start what's waiting, while there's room.
  drain(m) {
    while (m.queue.length && this.busy(m) < m.parallel && !(m.paused && !['task', 'mention'].includes(m.queue[0].job))) {
      const w = m.queue.shift();
      this.#start(m, w).catch((err) => this.#failed(m, w, err));
    }
  }

  #failed(m, w, err) {
    m.log.unshift({ at: this.now(), job: w.job, title: 'Couldn’t start', summary: truncate(err.message, 160), status: 'blocked' });
    m.log.length = Math.min(m.log.length, LOG_MAX);
    if (w.reply) this.#answer(w.reply, { status: 'error', error: `${m.name} couldn’t start: ${err.message}` });
    this.#changed();
  }

  // Check in now (the page's button): one check-in at a time per member.
  async checkin(m, { wake = false } = {}) {
    if (this.jobs(m).some((s) => s.crew.job === 'checkin' && (s.state === 'running' || s.state === 'waiting')) || m.queue.some((w) => w.job === 'checkin')) return { already: true };
    return this.assign(m, { job: 'checkin', wake });
  }

  // Every 20 s: check-ins that are due, and queues with room.
  async tick() {
    const now = this.now();
    for (const m of this.list) {
      if (dueNow(m, now)) {
        const wake = !!m.wakeAt && m.wakeAt <= now;
        m.lastMinute = Math.floor(now / 60_000);
        if (wake) m.wakeAt = null;
        await this.checkin(m, { wake }).catch((err) => this.#failed(m, { job: 'checkin' }, err));
        this.#changed();
      }
      // Jobs on its machine that finished while we weren't told (a dropped stream, a restart).
      if (m.machine) for (const s of this.jobs(m)) this.remoteSeen(s);
      this.drain(m);
    }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => console.warn(`wisp: crew: ${err.message}`)), 20_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  // The soonest check-in, for GET /api/status (a host wakes this wisp for it).
  nextWake() {
    return this.list.map((m) => nextCheckin(m, this.now())).filter(Boolean).sort((a, b) => a - b)[0] || null;
  }

  // @Name in a follow-up: the member gets the message as a job, and its answer shows on the task
  // under the message (a side entry like /btw's, with the member as who answers).
  // tagged: other members named in it, who join the job's delegates.
  async ask(m, task, text, attachments = [], tagged = []) {
    const turn = task.turns.at(-1);
    if (!turn) throw bad('Nothing to ask about yet.', 409);
    const entry = { id: newId(), question: text, status: 'running', askedAt: this.now(), crew: { id: m.id, name: m.name, avatar: m.avatar, color: m.color } };
    (turn.btw ||= []).push(entry);
    this.runner.sideChanged(task, turn);
    const reply = { sessionId: task.id, turnId: turn.id, entryId: entry.id };
    try {
      const out = await this.assign(m, { prompt: text, job: 'mention', from: { id: task.id, title: task.title }, attachments, reply, tagged });
      if (out.session) entry.job = out.session.id;
      else entry.queued = true;
      this.runner.sideChanged(task, turn);
      return { entry, ...out };
    } catch (err) {
      Object.assign(entry, { status: 'error', error: err.message, answeredAt: this.now() });
      this.runner.sideChanged(task, turn);
      throw err;
    }
  }

  #answer({ sessionId, turnId, entryId }, patch) {
    const task = this.store.get(sessionId);
    const turn = task?.turns.find((t) => t.id === turnId);
    const entry = turn?.btw?.find((b) => b.id === entryId);
    if (!entry) return;
    Object.assign(entry, patch, { answeredAt: this.now() });
    delete entry.queued;
    this.runner.sideChanged(task, turn);
  }

  // A lead delegates to a member: a job of its own (not a hidden child), so the user sees the
  // member get work. Sync, like the rest of delegate(): the session is made now, its run starts
  // once launched. Returns the session, or { error }.
  #delegate(lead, member, prompt) {
    const m = this.get(member.crew);
    if (!m) return { error: `${member.label || member.name} is no longer on the user's crew.` };
    if (this.busy(m) >= m.parallel) return { error: `${m.name} is already running ${m.parallel} job${m.parallel > 1 ? 's' : ''}, their limit. Wait for one with subagent_results, or do it yourself.` };
    // On its machine: the lead reads the job as we last fetched it, refreshed when it's done.
    if (m.machine)
      return this.#startAway(m, { prompt, ...(m.cwd ? { cwd: m.cwd } : { scratch: true }), agent: m.agent, model: m.model || undefined, effort: m.effort || undefined, mode: m.mode, ...this.#teamFor(m, 'delegated') }, { id: m.id, job: 'delegated', from: { id: lead.id, title: lead.title } })
        .then((s) => this.remote.fetch(s.id))
        .then((full) => (this.fetched.set(full.id, full), full));
    return this.launch(
      { prompt, ...(m.cwd ? { cwd: m.cwd } : { scratch: true }), agent: m.agent, model: m.model || undefined, effort: m.effort || undefined, mode: m.mode, ...this.#teamFor(m, 'delegated') },
      null,
      { crew: { id: m.id, job: 'delegated', from: { id: lead.id, title: lead.title } } },
    ).then(([s]) => this.store.get(s.id));
  }

  // Sync, as the job's turn ends (runner.#finishTurn): the crew block becomes memory. A quiet
  // check-in is filed rather than shown.
  #turnDone(s, turn) {
    const m = this.get(s.crew?.id);
    if ((!m && !s.crew?.note) || turn.status !== 'done') return {};
    const data = takeCrewBlock(turn.presentation);
    // A member of another wisp: its memory lives there, which fetches this turn's block (crewOut).
    if (m) applyMemory(m, data, this.now());
    if (m && data?.kit) this.#offer(m, s, data.kit);
    if (data) turn.crewOut = data;
    // Worth reading, not urgent: For later instead of a ping, and it beats quiet (there's something
    // to read). Only where nobody waits on the answer: a check-in's (or a watch's) first turn.
    const nobodyWaits = QUIET_JOBS.has(s.crew.job) && s.turns.length === 1;
    const later = !!data?.forLater && nobodyWaits;
    const quiet = !!data?.quiet && nobodyWaits && !later;
    // A delegation's answer goes to its lead, which asked for it: the job itself is filed under
    // Done. One the user asked for by @mention stays in Needs you until they mark it done.
    const filed = s.crew.job === 'delegated'; // every turn
    if (data && m) this.#changed();
    return { quiet, filed, later };
  }

  // A job on a member's machine changed (its summary streamed in, or the tick saw it). Once a turn
  // there has ended, fetch it and file it like one here: memory, log, an @mention's answer, the
  // lead's delegation. Each turn once.
  async remoteSeen(sum) {
    const m = this.get(sum?.crew?.id);
    if (!m?.machine || !this.remote || sum.state === 'running' || sum.pending) return;
    const key = `${sum.id}:${sum.turnCount || 0}`;
    if (m.seen.includes(key) || this.filing.has(key)) return;
    this.filing.add(key);
    try {
      const s = await this.remote.fetch(sum.id);
      const turn = s?.turns?.at(-1);
      if (!turn || turn.status === 'running' || m.seen.includes(key)) return;
      m.seen.push(key);
      if (m.seen.length > SEEN_MAX) m.seen.splice(0, m.seen.length - SEEN_MAX);
      this.fetched.set(s.id, s);
      if (turn.status === 'done') applyMemory(m, turn.crewOut, this.now());
      if (turn.status === 'done' && turn.crewOut?.kit) this.#offer(m, s, turn.crewOut.kit);
      const quiet = turn.status === 'done' && !!s.archived && QUIET_JOBS.has(s.crew?.job);
      m.log.unshift(logEntry(s, turn, { quiet }));
      m.log.length = Math.min(m.log.length, LOG_MAX);
      const reply = m.away[s.id]?.reply;
      if (reply) this.#answer(reply, turn.status === 'done' ? { status: 'done', answer: reportText(turn) || '_No report._', job: s.id } : { status: 'error', error: turn.status === 'stopped' ? `${m.name} was stopped.` : `${m.name}’s job failed.`, job: s.id });
      delete m.away[s.id];
      if (turn.status === 'done') this.#sendFollowUps(m, s, turn.crewOut?.followUps);
      if (s.crew?.from?.id) this.runner.touchLead?.(s.crew.from.id, s.id);
      this.#changed();
      setImmediate(() => this.drain(m));
    } catch {
      // the machine went away: the tick tries again
    } finally {
      this.filing.delete(key);
    }
  }

  #ended({ session: s, turn, interrupted }) {
    const m = this.get(s.crew?.id);
    if (!m || interrupted) return;
    const quiet = turn.status === 'done' && !!s.archived && QUIET_JOBS.has(s.crew.job);
    m.log.unshift(logEntry(s, turn, { quiet }));
    m.log.length = Math.min(m.log.length, LOG_MAX);
    if (s.crew.reply && s.turns.at(-1) === turn) {
      const ok = turn.status === 'done';
      this.#answer(s.crew.reply, ok ? { status: 'done', answer: reportText(turn) || '_No report._', job: s.id } : { status: 'error', error: turn.status === 'stopped' ? `${m.name} was stopped.` : `${m.name}’s job failed.`, job: s.id });
    }
    if (turn.status === 'done') this.#sendFollowUps(m, s, turn.crewOut?.followUps);
    this.#changed();
    setImmediate(() => this.drain(m));
  }

  // Make a spell's member yours: everything about them becomes editable, and the spell no longer
  // changes them (a review it asked for still stands).
  detach(m) {
    delete m.spell;
    this.#changed();
  }

  changed() {
    this.#changed();
  }

  #changed() {
    this.store.saveConfig();
    this.onChange();
  }
}
