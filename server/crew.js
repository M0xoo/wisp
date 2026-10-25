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
// (its page, or @Name in any prompt or follow-up), a lead's `delegate` call, or a trigger. Jobs past
// the member's `parallel` limit wait in its queue. A check-in that found nothing says `quiet`: it's
// logged and archived instead of landing in Needs you.

import { blocksToMarkdown } from './render.js';
import { cronMatches, nextRun, parseCron } from './triggers.js';
import { adapters } from './adapters/index.js';
import { bad, MODES, newId, truncate } from './util.js';

export const MAX_CREW = 12;
export const MAX_PARALLEL = 5;
export const BRIEF_MAX = 4000;
export const NOTEBOOK_SOFT = 6000; // what the member is asked to stay under
export const NOTEBOOK_MAX = 12000; // past this the oldest lines go
export const CREW_COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];
export const JOBS = new Set(['checkin', 'task', 'delegated', 'trigger', 'mention']);
const LOG_MAX = 40;
const LOG_IN_PROMPT = 12;
const QUEUE_MAX = 20;
const WAKE_MIN = 5; // minutes
const WAKE_MAX = 7 * 24 * 60;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
const ID = /^[a-z0-9]{6,40}$/;
// The kept parts of a job's report, for the log, a lead and an @mention's answer.
const KEEP = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tests', 'commits', 'checklist', 'callout', 'question', 'next']);

// How a mention of a member is stored in a prompt (the page's prompt boxes make these; a plain
// `@Ada` typed anywhere works too).
export const CREW_MENTION = /@\[([^\]\n]{1,200})\]\(crew:([a-z0-9]{6,40})\)/g;
export const handleOf = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- members ---------------------------------------------------------------------------------

// body → a clean member. prev: the member being edited (its memory and bookkeeping carry on).
// taken: the other members, for unique names.
export function normalizeMember(body = {}, prev = null, { taken = [], exists = () => true } = {}) {
  const v = (k, d = '') => (body[k] !== undefined ? body[k] : prev?.[k] !== undefined ? prev[k] : d);
  const name = String(v('name')).replace(/\s+/g, ' ').trim();
  if (!name) throw bad('Give them a name.');
  if (!NAME.test(name)) throw bad('A name is up to 24 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.');
  if (taken.some((m) => m.id !== prev?.id && handleOf(m.name) === handleOf(name))) throw bad(`${name} is already on your crew. Pick another name.`);
  const cwd = String(v('cwd'));
  if (cwd && !exists(cwd)) throw bad(`Not a folder on this computer: ${cwd}`);
  const agent = String(v('agent', 'auto')) || 'auto';
  if (agent !== 'auto' && (!adapters[agent] || agent === 'wisp')) throw bad(`Unknown harness: ${agent}`);
  const mode = String(v('mode', 'auto'));
  if (!MODES.has(mode)) throw bad('mode must be plan, edits or auto.');
  const cron = String(v('cron')).trim();
  if (cron) parseCron(cron);
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
    agent,
    model: String(v('model')).slice(0, 120),
    effort: /^[\w-]{0,20}$/.test(String(v('effort'))) ? String(v('effort')) : '',
    mode,
    cron,
    parallel: Math.min(MAX_PARALLEL, Math.max(1, Math.floor(Number(v('parallel', 2))) || 2)),
    paused: v('paused', false) === true,
    notebook,
    // Bookkeeping: what it did and what's next.
    log: prev?.log || [],
    queue: prev?.queue || [],
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
const avatarOf = (a) => (SPIRIT.test(String(a || '')) ? String(a) : [...String(a || '').trim()].slice(0, 4).join(''));

function clampNotebook(text) {
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
const JOB_LABEL = { checkin: 'check-in', task: 'from the user', delegated: 'delegated', trigger: 'trigger', mention: 'tagged' };

// Appended to a job's system prompt: who it is, its memory, where this job came from and how to
// hand memory back.
export function crewNote(m, job = {}) {
  const log = (m.log || []).slice(0, LOG_IN_PROMPT);
  const from = job.from?.title ? `"${job.from.title}" (wisp task ${job.from.id})` : 'another task';
  const what = {
    checkin: `A check-in${m.cron ? ' on your schedule' : ''}${job.wake ? ', at the time you asked to look again' : ''}. Do your standing job from the brief: find what changed since your last check-in (your notebook has what you saw then), act on it, and report.`,
    task: 'A task from the user, sent to you directly.',
    delegated: `Delegated to you by the agent working on ${from}. That agent reads your report; it can't see your notebook, so say everything it needs.`,
    trigger: `Started by the trigger "${job.from?.title || 'a trigger'}".`,
    mention: `The user tagged you in ${from}. Your answer shows there, under their message. Read that task with wisp_session if you need its context.`,
  }[job.job || 'task'];
  return `

## You are ${m.name}, on the user's crew

${m.role ? `Your role: ${m.role}. ` : ''}You are one of the user's long-lived agents. wisp hands you work as separate jobs: on your schedule (check-ins), from the user, from other tasks' agents and from triggers. Several can run at once, each in its own context. What carries over from job to job is your brief, your notebook and the log below, so keep the notebook current.

### Your brief (from the user)

${m.brief || '(none yet: do what each job asks)'}

### Your notebook

${m.notebook ? `<notebook>\n${m.notebook}\n</notebook>` : 'Empty so far.'}

### Your recent jobs (newest first)

${log.length ? log.map((l) => `- ${when(l.at)} · ${JOB_LABEL[l.job] || l.job} · ${l.title}${l.summary ? `: ${l.summary}` : ''}${l.quiet ? ' (nothing new)' : ''}`).join('\n') : 'None yet: this is your first.'}

### This job

${what}

### Memory and reporting

Put one \`crew\` block last in your final message's blocks. wisp reads it and doesn't show it to the user:
{"type":"crew","remember":["…"],"notebook":"…","wakeIn":30,"quiet":true}
- remember: lasting facts to add to your notebook: ids, versions and states you'll compare against next time, the user's preferences for this job, open threads. Other jobs of yours may write at the same time, so add lines with remember rather than rewriting.
- notebook: the whole notebook rewritten, only to tidy it (it has ${m.notebook.length} characters; keep it under ${NOTEBOOK_SOFT}). Drop what's stale.
- wakeIn: minutes until wisp should start a check-in (at least ${WAKE_MIN}), when you want to look again sooner than your schedule (a deploy to check on, a run to wait for).
- quiet: ${job.job === 'checkin' ? 'true when this check-in found nothing the user needs to see: wisp logs it and doesn’t notify them. Leave it out when there is something to report.' : 'only for check-ins; this job is waited on, so always report.'}
Leave out the fields you don't need, and keep secrets out of the notebook.`;
}

// The prompt a check-in starts with.
export const checkinPrompt = (m, { wake = false } = {}) => `Check-in #${(m.checkins || 0) + 1}${wake ? ' (you asked to look again)' : ''}: do your standing job and report what changed.`;

// --- what a job hands back -----------------------------------------------------------------------

// Takes the `crew` blocks out of a presentation: { remember, notebook, wakeIn, quiet } (merged).
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
  }
  out.remember = out.remember.slice(0, 12);
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
    status,
    ...(quiet && { quiet: true }),
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

// Stored crew mentions as an agent or a person reads them: `@Ada`.
export const plainCrew = (text = '') => String(text).replace(CREW_MENTION, '@$1');

// --- the service -----------------------------------------------------------------------------------

// launch(body, origin, { crew }) starts a job like POST /api/sessions; onChange() after changes.
export class Crew {
  constructor({ store, runner, launch, onChange = () => {}, exists = () => true, now = () => Date.now() }) {
    Object.assign(this, { store, runner, launch, onChange, exists, now });
    store.config.crew ||= [];
    this.starting = new Map(); // member id -> jobs being launched (not sessions yet)
    runner.crewNote = (s) => {
      const m = this.get(s.crew?.id);
      return m ? crewNote(m, s.crew) : '';
    };
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
    return { ...m, running: jobs.filter((s) => s.state === 'running' || s.state === 'waiting').length + (this.starting.get(m.id) || 0), jobs: jobs.length, nextAt: nextCheckin(m, this.now()), handle: handleOf(m.name) };
  }

  jobs(m) {
    return this.store.all().filter((s) => s.crew?.id === m.id);
  }

  busy(m) {
    return this.jobs(m).filter((s) => s.state === 'running' || s.state === 'waiting').length + (this.starting.get(m.id) || 0);
  }

  create(body) {
    if (this.list.length >= MAX_CREW) throw bad(`Your crew is full (${MAX_CREW}). Remove someone first.`);
    const m = normalizeMember(body, null, { taken: this.list, exists: this.exists });
    this.list.push(m);
    this.#changed();
    return m;
  }

  update(m, body) {
    const wasPaused = m.paused;
    Object.assign(m, normalizeMember(body, m, { taken: this.list, exists: this.exists }));
    this.#changed();
    if (wasPaused && !m.paused) this.drain(m);
    return m;
  }

  // Leaves the crew. Its jobs stay as ordinary tasks; triggers that sent it work stop.
  remove(m) {
    this.store.config.crew = this.list.filter((x) => x !== m);
    for (const t of this.store.config.triggers || []) if (t.crew === m.id) Object.assign(t, { crew: '', enabled: false, lastError: `${m.name} left your crew.` });
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
  async assign(m, { prompt, job = 'task', from = null, origin = null, attachments = [], reply = null, wake = false } = {}) {
    if (!JOBS.has(job)) job = 'task';
    const text = String(prompt || '').trim() || (job === 'checkin' ? checkinPrompt(m, { wake }) : '');
    if (!text) throw bad('Tell them what to do.');
    const w = { id: newId(), prompt: text, job, ...(from && { from }), ...(origin && { origin }), ...(attachments.length && { attachments }), ...(reply && { reply }), ...(wake && { wake: true }), at: this.now() };
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
      const crew = { id: m.id, job: w.job, ...(w.from && { from: w.from }), ...(w.reply && { reply: w.reply }), ...(w.wake && { wake: true }) };
      const [s] = await this.launch(
        { prompt: w.prompt, ...(m.cwd ? { cwd: m.cwd } : { scratch: true }), agent: m.agent, model: m.model || undefined, effort: m.effort || undefined, mode: m.mode, attachments: w.attachments || [] },
        w.origin || null,
        { crew },
      );
      return s;
    } finally {
      this.starting.set(m.id, this.starting.get(m.id) - 1);
      this.#changed();
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
  async ask(m, task, text, attachments = []) {
    const turn = task.turns.at(-1);
    if (!turn) throw bad('Nothing to ask about yet.', 409);
    const entry = { id: newId(), question: text, status: 'running', askedAt: this.now(), crew: { id: m.id, name: m.name, avatar: m.avatar, color: m.color } };
    (turn.btw ||= []).push(entry);
    this.runner.sideChanged(task, turn);
    const reply = { sessionId: task.id, turnId: turn.id, entryId: entry.id };
    try {
      const out = await this.assign(m, { prompt: text, job: 'mention', from: { id: task.id, title: task.title }, attachments, reply });
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
    return this.launch(
      { prompt, ...(m.cwd ? { cwd: m.cwd } : { scratch: true }), agent: m.agent, model: m.model || undefined, effort: m.effort || undefined, mode: m.mode },
      null,
      { crew: { id: m.id, job: 'delegated', from: { id: lead.id, title: lead.title } } },
    ).then(([s]) => this.store.get(s.id));
  }

  // Sync, as the job's turn ends (runner.#finishTurn): the crew block becomes memory. A quiet
  // check-in is filed rather than shown.
  #turnDone(s, turn) {
    const m = this.get(s.crew?.id);
    if (!m || turn.status !== 'done') return {};
    const data = takeCrewBlock(turn.presentation);
    applyMemory(m, data, this.now());
    const quiet = !!data?.quiet && s.crew.job === 'checkin' && s.turns.length === 1;
    // An answer to an @mention lands on the task that asked, a delegation's on its lead: the job
    // itself is filed under Done instead of waiting in Needs you too.
    const filed = (s.crew.job === 'mention' || s.crew.job === 'delegated') && s.turns.length === 1;
    if (data) this.#changed();
    return { quiet, filed };
  }

  #ended({ session: s, turn, interrupted }) {
    const m = this.get(s.crew?.id);
    if (!m || interrupted) return;
    const quiet = turn.status === 'done' && !!s.archived && s.crew.job === 'checkin';
    m.log.unshift(logEntry(s, turn, { quiet }));
    m.log.length = Math.min(m.log.length, LOG_MAX);
    if (s.crew.reply && s.turns.at(-1) === turn) {
      const ok = turn.status === 'done';
      this.#answer(s.crew.reply, ok ? { status: 'done', answer: reportText(turn) || '_No report._', job: s.id } : { status: 'error', error: turn.status === 'stopped' ? `${m.name} was stopped.` : `${m.name}’s job failed.`, job: s.id });
    }
    this.#changed();
    setImmediate(() => this.drain(m));
  }

  #changed() {
    this.store.saveConfig();
    this.onChange();
  }
}
