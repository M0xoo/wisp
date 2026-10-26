// Later: work wisp does at a time you or an agent set (design/later.md). Three kinds:
//   follow-up  session.later [{ id, at, text, by, setAt }]: sent into that same task when due, so
//              its agent carries on with its whole conversation (the agent's resume_later, or
//              Send later in the reply box)
//   reminder   a session.later entry with remind: true brings that task back to Needs you with its
//              text (s.reminder); a plan { kind: 'reminder' } becomes a small task of its own
//   task       a plan { kind: 'task', body }: a launch body, started when due
// Plans live in config.later (they have no task yet); follow-ups live on their task, so they move,
// sync and go with it. Nothing waits on a timer: tick() looks every 20 s, and after a restart what
// came due while wisp was off fires once, marked late (or, a day late, lands in Needs you instead).

import { bad, newId } from './util.js';

export const MIN_MS = 60_000;
export const MAX_MS = 30 * 24 * 3600_000; // a month: yours
export const AGENT_MAX_MS = 7 * 24 * 3600_000; // an agent's own wake-ups
export const PER_TASK = 5; // pending on one task
export const CHAIN_MAX = 10; // an agent's wake-ups in a row with no word from you
const LATE_MS = 2 * 60_000; // later than this: the agent is told it's late
const MISSED_MS = 24 * 3600_000; // later than this: you decide, it doesn't just run
const PER_TICK = 3; // a restart with a backlog doesn't start a dozen runs at once
const TICK_MS = 20_000;
const TEXT_MAX = 4000;
// The follow-up that carries a task on after a usage limit: the limit card's Wait until, and wisp's
// own with Settings → Wait for the reset on. The page knows the card was answered by this text.
export const LIMIT_CARRY_ON = 'Carry on from where the last run stopped at the usage limit.';

// { at } or { in: minutes } → a time from now, checked against the limits.
export function whenOf(body, { now = Date.now(), max = MAX_MS } = {}) {
  let at = body.at;
  if (typeof at === 'string' && at.trim()) at = Date.parse(at);
  if (at === undefined || at === null || at === '') at = body.in !== undefined ? now + Number(body.in) * 60_000 : NaN;
  if (!Number.isFinite(at)) throw bad('Say when: at (a time) or in (minutes).');
  at = Math.round(at);
  if (at < now + MIN_MS - 1000) throw bad('Pick a time at least a minute from now.');
  if (at > now + max) throw bad(`Pick a time within ${max === MAX_MS ? 'a month' : 'a week'}.`);
  return at;
}

const textOf = (t, what = 'text') => {
  const s = String(t ?? '').trim();
  if (!s) throw bad(`${what} required`);
  return s.slice(0, TEXT_MAX);
};

// "14:32" today, "yesterday 14:32", "Mon 14:32" further: in what wisp writes on a reminder.
export function clock(t, now = Date.now()) {
  const d = new Date(t);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x).toDateString();
  if (day(t) === day(now)) return hm;
  if (day(t) === day(now - 86400_000)) return `yesterday ${hm}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

// What the page and machines see of a task's follow-ups.
export const laterView = (s) => (s.later?.length ? s.later.map(({ id, at, text, by, setAt, remind, attachments }) => ({ id, at, text, by, setAt, ...(remind && { remind: true }), ...(attachments?.length && { files: attachments.length }) })) : undefined);

// The note the agent reads ahead of a follow-up it (or you) scheduled. The bubble shows only the text.
export function laterNote(l, now = Date.now()) {
  const t = (x) => clock(x, now);
  const who = l.by === 'agent' ? 'you' : l.by === 'user' ? 'the user' : l.by;
  const late = l.late ? ` It was due at ${t(l.at)} but wisp wasn't running then, so it's ${Math.round((now - l.at) / 60_000)} min late: check the current state before you act on anything you saw before.` : '';
  return `(wisp: this is the follow-up ${who} scheduled at ${t(l.setAt)} for ${t(l.at)}. Carry on from where this conversation left off.${late})`;
}

export class Later {
  // runner: the Runner. launch(body, origin): a new task (services/launch.js launchAny). uploads: follow-ups' files.
  // changed(s): a session's fields changed (persist + summary). configChanged(): config.later did.
  // notify(s): a reminder came due (the page's notification, the phone).
  constructor({ store, runner, launch, uploads = null, changed = () => {}, configChanged = () => {}, notify = () => {}, now = () => Date.now() }) {
    Object.assign(this, { store, runner, launch, uploads, changed, configChanged, notify, now });
    store.config.later ||= [];
  }

  get plans() {
    return this.store.config.later;
  }

  // --- follow-ups and reminders on a task ---------------------------------------------------

  // by: 'user' | 'agent' | a crew member's name. remind: a reminder about this task, no agent run.
  // attachments: upload ids, sent with it when it goes (they stay on disk until then).
  add(s, { text, remind = false, by = 'user', attachments, ...when }) {
    if (s.parentId || s.delegated) throw bad('A subagent can’t schedule follow-ups: its lead can.');
    if (s.kind === 'reminder') throw bad('That’s a reminder: snooze it instead.');
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to schedule things.');
    s.later ||= [];
    if (s.later.length >= PER_TASK) throw bad(`A task can have ${PER_TASK} follow-ups scheduled at most. Cancel one first.`);
    const agent = by !== 'user';
    if (agent && (s.laterChain || 0) >= CHAIN_MAX) throw bad(`That's ${CHAIN_MAX} scheduled follow-ups in a row with no word from the user. Don't schedule another: report where things stand, and the user can follow up.`);
    const entry = { id: newId(), at: whenOf(when, { now: this.now(), max: agent ? AGENT_MAX_MS : MAX_MS }), text: textOf(text, remind ? 'What to remind you about' : 'The follow-up'), by, setAt: this.now(), ...(remind && { remind: true }) };
    const files = !remind && Array.isArray(attachments) ? attachments.filter((a) => typeof a === 'string').slice(0, 20) : [];
    if (files.length) entry.attachments = files;
    s.later.push(entry);
    s.later.sort((a, b) => a.at - b.at);
    this.changed(s);
    return entry;
  }

  // { at | in, text }: another time or message. now: true sends it now (Send now).
  async edit(s, id, body) {
    if (id === 'reminder') return this.snooze(s, body);
    const l = s.later?.find((x) => x.id === id);
    if (!l) throw bad('Already sent, or cancelled.', 404);
    if (body.now === true) return this.fire(s, l, { force: true });
    if (body.at !== undefined || body.in !== undefined) l.at = whenOf(body, { now: this.now() });
    if (body.text !== undefined) l.text = textOf(body.text);
    s.later.sort((a, b) => a.at - b.at);
    this.changed(s);
    return l;
  }

  cancel(s, id) {
    const i = s.later?.findIndex((x) => x.id === id) ?? -1;
    if (i < 0) return false;
    s.later.splice(i, 1);
    if (!s.later.length) delete s.later;
    this.changed(s);
    return true;
  }

  // A reminder that came due, back for later: the task leaves Needs you until then.
  snooze(s, body) {
    const r = s.reminder;
    if (!r) throw bad('Nothing to snooze.', 404);
    const at = whenOf(body, { now: this.now() });
    if (s.kind === 'reminder') {
      // A reminder of its own goes back to being a plan, and the task with it.
      const plan = { id: newId(), kind: 'reminder', at, text: r.text, setAt: r.setAt, ...(r.from && { from: r.from }) };
      this.plans.push(plan);
      this.#dropSession(s);
      this.configChanged();
      return plan;
    }
    delete s.reminder;
    s.later ||= [];
    const entry = { id: newId(), at, text: r.text, by: r.by || 'user', setAt: r.setAt, remind: true };
    s.later.push(entry);
    s.later.sort((a, b) => a.at - b.at);
    if (r.was) s.state = r.was;
    s.unread = false;
    this.changed(s);
    return entry;
  }

  // Marked done: the agent's own wake-ups go (it was told it's finished); yours stay.
  done(s) {
    if (s.reminder) delete s.reminder;
    if (!s.later?.some((l) => l.by !== 'user')) return;
    s.later = s.later.filter((l) => l.by === 'user');
    if (!s.later.length) delete s.later;
  }

  // Whether a task's follow-up can go now: not while its agent runs, asks you (an answer would
  // take the follow-up's place), waits on delegates or Auto is checking its work.
  #free(s) {
    if (this.runner.live.has(s.id) || this.runner.deleting?.has(s.id)) return false;
    if (s.ask || s.state === 'running' || s.state === 'waiting' || s.auto?.busy) return false;
    return !s.turns.at(-1)?.delegations?.some((d) => this.store.get(d.sessionId)?.turns.at(-1)?.status === 'running');
  }

  // force: Send now, whatever the clock says (still not over a live run: it queues behind it).
  async fire(s, l, { force = false } = {}) {
    const now = this.now();
    s.later = s.later.filter((x) => x !== l);
    if (!s.later.length) delete s.later;
    if (l.remind) {
      const was = s.state === 'running' || s.state === 'waiting' ? 'review' : s.state;
      s.reminder = { text: l.text, at: l.at, setAt: l.setAt, by: l.by, was };
      s.state = s.state === 'running' || s.state === 'waiting' ? s.state : 'review';
      s.unread = true;
      delete s.archived;
      delete s.forLater; // it needs you now: out of For later
      this.changed(s);
      this.notify(s);
      return { reminded: true };
    }
    const late = !force && now - l.at > LATE_MS;
    this.changed(s);
    return this.runner.reply(s, l.text, this.uploads?.resolve(l.attachments) || [], { queue: true, by: 'later', later: { by: l.by, setAt: l.setAt, at: l.at, ...(late && { late: true }) } });
  }

  // --- plans: a task or a reminder that doesn't exist yet -------------------------------------

  // { kind: 'task', body: launch body } or { kind: 'reminder', text, from?: { id, title } }.
  plan({ kind, body, text, from, ...when }) {
    if (kind !== 'task' && kind !== 'reminder') throw bad('kind must be task or reminder.');
    const at = whenOf(when, { now: this.now() });
    const p = { id: newId(), kind, at, setAt: this.now() };
    if (kind === 'task') {
      if (!body || typeof body !== 'object') throw bad('body required: the task to start.');
      const { prompt, ...rest } = body;
      p.body = { ...rest, prompt: textOf(prompt, 'prompt') };
      p.title = p.body.prompt.split('\n')[0].slice(0, 80);
    } else {
      p.text = textOf(text, 'What to remind you about');
      if (from?.id) p.from = { id: String(from.id).slice(0, 60), title: String(from.title || '').slice(0, 200) };
    }
    this.plans.push(p);
    this.plans.sort((a, b) => a.at - b.at);
    this.configChanged();
    return p;
  }

  getPlan(id) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) throw bad('Already started, or cancelled.', 404);
    return p;
  }

  async editPlan(id, body) {
    const p = this.getPlan(id);
    if (body.now === true) return this.#runPlan(p);
    if (body.at !== undefined || body.in !== undefined) p.at = whenOf(body, { now: this.now() });
    if (body.text !== undefined && p.kind === 'reminder') p.text = textOf(body.text);
    if (body.prompt !== undefined && p.kind === 'task') (p.body.prompt = textOf(body.prompt, 'prompt')), (p.title = p.body.prompt.split('\n')[0].slice(0, 80));
    this.plans.sort((a, b) => a.at - b.at);
    this.configChanged();
    return p;
  }

  cancelPlan(id) {
    const i = this.plans.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.plans.splice(i, 1);
    this.configChanged();
    return true;
  }

  async #runPlan(p) {
    this.plans.splice(this.plans.indexOf(p), 1);
    this.configChanged();
    if (p.kind === 'reminder') return { session: this.#reminderTask(p) };
    try {
      const [s] = await this.launch(p.body, { kind: 'later', id: p.id, name: 'Scheduled' });
      return { session: s };
    } catch (err) {
      // It couldn't start (the folder went, a harness was removed): say so where you'll see it.
      return { session: this.#reminderTask({ ...p, text: `Couldn’t start “${p.title}” at the time you set: ${err.message}`, failed: true }) };
    }
  }

  // A reminder of its own: a finished task with one turn, in Needs you. It has no agent to talk to.
  #reminderTask(p) {
    const now = this.now();
    const id = newId();
    const set = clock(p.setAt, now);
    const s = {
      id,
      title: (p.text || '').split('\n')[0].slice(0, 120),
      titleAuto: false,
      kind: 'reminder',
      agent: this.store.config.defaults?.agent && this.store.config.defaults.agent !== 'auto' ? this.store.config.defaults.agent : 'claude',
      cwd: this.store.scratchDir(id),
      mode: 'plan',
      model: '',
      state: 'review',
      unread: true,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      queue: [],
      reminder: { text: p.text, at: p.at, setAt: p.setAt, by: 'user', ...(p.from && { from: p.from }) },
      turns: [
        {
          id: newId(),
          prompt: p.text,
          startedAt: p.setAt,
          endedAt: now,
          status: 'done',
          stats: null,
          activity: [],
          changes: [],
          presentation: { blocks: [{ type: 'hero', title: (p.text || '').split('\n')[0].slice(0, 120), summary: p.failed ? '' : `A reminder you set at ${set}${p.from ? ` in “${p.from.title}”` : ''}.`, status: p.failed ? 'blocked' : 'info' }] },
        },
      ],
    };
    this.store.put(s);
    this.changed(s);
    this.notify(s);
    return s;
  }

  #dropSession(s) {
    this.store.delete(s.id);
    this.onRemoved?.(s);
  }

  // --- the clock ----------------------------------------------------------------------------

  async tick() {
    const now = this.now();
    let fired = 0;
    for (const p of this.plans.filter((x) => x.at <= now)) {
      if (fired >= PER_TICK) return;
      fired++;
      // A task a day overdue isn't started behind your back: it becomes a reminder that it was missed.
      if (p.kind === 'task' && now - p.at > MISSED_MS) {
        this.plans.splice(this.plans.indexOf(p), 1);
        this.configChanged();
        this.#reminderTask({ ...p, text: `Missed: “${p.title}” was due at ${clock(p.at, now)} while wisp was off. Start it again if you still want it.`, failed: true });
        continue;
      }
      await this.#runPlan(p).catch((err) => console.warn(`wisp: later: ${err.message}`));
    }
    for (const s of this.store.all()) {
      const due = s.later?.filter((l) => l.at <= now);
      if (!due?.length) continue;
      // Archived: you put it away, so what it had scheduled lapses.
      if (s.archived) {
        s.later = s.later.filter((l) => l.at > now);
        if (!s.later.length) delete s.later;
        this.changed(s);
        continue;
      }
      const l = due[0];
      if (!l.remind && !this.#free(s)) continue; // held; tries again next tick
      if (fired >= PER_TICK) return;
      fired++;
      if (!l.remind && now - l.at > MISSED_MS) {
        // A day late: the task comes back to Needs you with the follow-up, unsent.
        s.later = s.later.filter((x) => x !== l);
        if (!s.later.length) delete s.later;
        s.reminder = { text: `Missed follow-up (due at ${clock(l.at, now)}, wisp was off): ${l.text}`, at: l.at, setAt: l.setAt, by: l.by, was: s.state, missed: true };
        s.state = 'review';
        s.unread = true;
        delete s.forLater;
        this.changed(s);
        this.notify(s);
        continue;
      }
      await Promise.resolve(this.fire(s, l)).catch((err) => console.warn(`wisp: later: ${err.message}`));
    }
  }

  // The soonest thing that will run, for GET /api/status: a host starts a stopped wisp for it.
  // Only what can go then, never in the past, or a host would never let an idle wisp stop.
  nextAt() {
    const now = this.now();
    const ats = this.plans.map((p) => p.at);
    for (const s of this.store.all()) if (s.later?.length && !s.archived && (s.later[0].remind || !s.ask)) ats.push(s.later[0].at);
    const next = ats.sort((a, b) => a - b)[0];
    return next ? Math.max(next, now + MIN_MS) : null;
  }

  start() {
    this.tick().catch((err) => console.warn(`wisp: later: ${err.message}`));
    this.timer = setInterval(() => this.tick().catch((err) => console.warn(`wisp: later: ${err.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
