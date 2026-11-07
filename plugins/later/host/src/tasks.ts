// Follow-ups and reminders on a task (v1 later.js add/edit/cancel/snooze/done/fire), For later
// (v1 routes/sessions.js PATCH forLater) and what a new turn clears. Rows first, then the ext mirror:
// the mirror is recomputed from the rows each time, one at a time per task, so it never goes stale.
import { randomBytes } from 'node:crypto';
import { AGENT_MAX_MS, CHAIN_MAX, EVENTS, LATE_MS, LaterError, laterView, MAX_MS, PER_TASK, textOf, whenOf } from '@wisp-plugin/later-api';
import type { LaterEntry, LaterExt, LaterHeld } from '@wisp-plugin/later-api';
import type { Attachment, Session, SessionId } from '@wisp-plugin/runtime-api';
import type { Json, NotifyService, PluginContext } from '@wisp/kernel';
import { COMMANDS as GOAL } from '@wisp-plugin/goal-api';
import type { Rows } from './rows.ts';
import { Rt } from './rt.ts';
import type { Runner } from './rt.ts';

export const newId = (): string => randomBytes(6).toString('hex');
const bad = (message: string, code = 'invalid'): LaterError => new LaterError(code, message);

export interface AddArgs {
  sessionId: string;
  text?: unknown;
  at?: unknown;
  in?: unknown;
  remind?: boolean;
  by?: string;
  attachments?: unknown;
  goal?: unknown;
  held?: LaterHeld;
  limit?: { agent: string; account: string };
}

export interface EditBody {
  at?: unknown;
  in?: unknown;
  text?: unknown;
  now?: unknown;
}

/** Attachments a follow-up carries: objects as the runtime takes them (v2 clients send them whole), 20 at most. */
function attachmentsOf(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const ok = (a: unknown): a is Attachment => typeof a === 'object' && a !== null && 'id' in a && typeof a.id === 'string' && 'name' in a && typeof a.name === 'string';
  return v.filter(ok).slice(0, 20).map((a) => ({ id: a.id, name: a.name, mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream', size: Number(a.size) || 0, ...(typeof a.path === 'string' && { path: a.path }) }));
}

/** v1 #free: a follow-up doesn't go over a live run (it would interrupt it); it waits for the next look. */
export const free = (s: Session): boolean => s.state !== 'running';

export class Tasks {
  readonly #ctx: PluginContext;
  readonly #rows: Rows;
  readonly #changed: () => void;
  readonly #mirrors = new Map<string, Promise<void>>();

  constructor(ctx: PluginContext, rows: Rows, changed: () => void) {
    this.#ctx = ctx;
    this.#rows = rows;
    this.#changed = changed;
  }

  get rows(): Rows {
    return this.#rows;
  }

  /** the task's ext slot, from its rows */
  extOf(sessionId: string): LaterExt | null {
    const views = this.#rows.entries(sessionId).map(laterView);
    const t = this.#rows.task(sessionId);
    const ext: LaterExt = {
      ...(views.length && { later: views }), ...(t?.for_later && { forLater: t.for_later }), ...(t?.reminder && { reminder: t.reminder }),
      ...(t?.kind === 'reminder' && { kind: 'reminder' as const }), ...(t?.origin && { origin: t.origin }), ...(t?.sent && { sent: t.sent }),
    };
    return Object.keys(ext).length ? ext : null;
  }

  /** Writes the task's ext slot from its rows, after any mirror still on its way. A task that went takes its rows. */
  mirror(r: Runner, sessionId: string): Promise<void> {
    const prev = this.#mirrors.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await new Rt(r).setExt(sessionId, this.extOf(sessionId) as Json);
      } catch (e) {
        if ((e as { code?: string }).code === 'not_found') this.#rows.forget(sessionId);
        else this.#ctx.log.warn(`later: mirror ${sessionId}: ${(e as Error).message}`);
      }
    });
    const settled = next.finally(() => this.#mirrors.get(sessionId) === settled && this.#mirrors.delete(sessionId));
    this.#mirrors.set(sessionId, settled);
    this.#changed();
    return settled;
  }

  async add(r: Runner, a: AddArgs): Promise<LaterEntry> {
    const s = await new Rt(r).get(a.sessionId);
    if (!s) throw bad('no such session', 'not_found');
    return this.addTo(r, s, a);
  }

  async addTo(r: Runner, s: Session, a: AddArgs): Promise<LaterEntry> {
    const by = a.by ?? 'user';
    const remind = a.remind === true;
    if (s.parentId) throw bad('A subagent can’t schedule follow-ups: its lead can.');
    const t = this.#rows.task(s.id);
    if (t?.kind === 'reminder') throw bad('That’s a reminder: snooze it instead.');
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to schedule things.');
    if (this.#rows.entries(s.id).length >= PER_TASK) throw bad(`A task can have ${PER_TASK} follow-ups scheduled at most. Cancel one first.`);
    const agent = by !== 'user';
    if (agent && (t?.chain ?? 0) >= CHAIN_MAX) throw bad(`That's ${CHAIN_MAX} scheduled follow-ups in a row with no word from the user. Don't schedule another: report where things stand, and the user can follow up.`);
    const now = this.#ctx.clock.now();
    const files = remind ? [] : attachmentsOf(a.attachments);
    const entry: LaterEntry = {
      id: newId(), sessionId: s.id, at: whenOf(a, { now, max: agent ? AGENT_MAX_MS : MAX_MS }), text: textOf(a.text, remind ? 'What to remind you about' : 'The follow-up'), by, setAt: now,
      ...(remind && { remind: true as const }), ...(by === 'wisp' && Number.isInteger(a.goal) && { goal: Number(a.goal) }), ...(a.held && { held: a.held }),
      ...(by === 'wisp' && a.limit && { limit: a.limit }), ...(files.length && { attachments: files }),
    };
    this.#rows.putEntry(entry);
    await this.mirror(r, s.id);
    this.#ctx.emit(EVENTS.added, { sessionId: s.id, entry: laterView(entry) as unknown as Json });
    return entry;
  }

  /** { at | in, text }: another time or message; now: true sends it now (Send now). item 'reminder' snoozes. */
  async edit(r: Runner, sessionId: string, item: string, body: EditBody): Promise<unknown> {
    if (item === 'reminder') return this.snooze(r, sessionId, body);
    const l = this.#rows.entries(sessionId).find((x) => x.id === item);
    if (!l) throw bad('Already sent, or cancelled.', 'not_found');
    if (body.now === true) {
      const s = await new Rt(r).get(sessionId);
      if (!s) throw bad('no such session', 'not_found');
      return this.fire(r, s, l, { force: true });
    }
    const next: LaterEntry = { ...l };
    if (body.at !== undefined || body.in !== undefined) {
      next.at = whenOf(body, { now: this.#ctx.clock.now() });
      delete next.held; // your time now, not the reset's
    }
    if (body.text !== undefined) next.text = textOf(body.text);
    this.#rows.putEntry(next);
    await this.mirror(r, sessionId);
    return next;
  }

  /** goalRound: the goal takes back the round it left waiting for the plan (no event: it knows). */
  async cancel(r: Runner, sessionId: string, o: { item?: string; goalRound?: boolean }): Promise<{ ok: boolean; entry?: LaterEntry }> {
    const l = this.#rows.entries(sessionId).find((x) => (o.goalRound ? x.goal !== undefined : x.id === o.item));
    if (!l) return { ok: false };
    this.#rows.dropEntries([l.id]);
    await this.mirror(r, sessionId);
    // a goal round that waited for the plan: the goal waits for you now, out of Scheduled
    if (l.goal !== undefined && !o.goalRound) this.#ctx.emit(EVENTS.dropped, { sessionId, entry: laterView(l) as unknown as Json, why: 'cancelled' });
    return { ok: true, entry: l };
  }

  /** A reminder that came due, back for later: the task leaves Needs you until then. */
  async snooze(r: Runner, sessionId: string, body: EditBody): Promise<unknown> {
    const t = this.#rows.task(sessionId);
    const rem = t?.reminder;
    if (!rem) throw bad('Nothing to snooze.', 'not_found');
    const now = this.#ctx.clock.now();
    const at = whenOf(body, { now });
    const rt = new Rt(r);
    if (t.kind === 'reminder') {
      // a reminder of its own goes back to being a plan, and the task with it
      const plan = { id: newId(), kind: 'reminder' as const, at, text: rem.text, setAt: rem.setAt, ...(rem.from && { from: rem.from }) };
      this.#rows.putPlan(plan);
      this.#rows.forget(sessionId);
      await rt.delete(sessionId).catch(() => undefined);
      this.#changed();
      return plan;
    }
    const entry: LaterEntry = { id: newId(), sessionId: sessionId as SessionId, at, text: rem.text, by: rem.by || 'user', setAt: rem.setAt, remind: true };
    this.#rows.putEntry(entry);
    this.#rows.editTask(sessionId, (x) => void (x.reminder = null));
    if (rem.was === 'done' || rem.was === 'review' || rem.was === 'error') await rt.setState(sessionId, rem.was);
    await rt.markRead(sessionId, false);
    await this.mirror(r, sessionId);
    return entry;
  }

  /** Marked done: the agent's own wake-ups go (it was told it's finished); yours stay. */
  async done(r: Runner, sessionId: string): Promise<void> {
    this.#rows.editTask(sessionId, (x) => void (x.reminder = null));
    const theirs = this.#rows.entries(sessionId).filter((l) => l.by !== 'user');
    this.#rows.dropEntries(theirs.map((l) => l.id));
    await this.mirror(r, sessionId);
    // a goal round that waited for the plan goes with them: the goal waits for you now
    for (const l of theirs.filter((x) => x.goal !== undefined)) this.#ctx.emit(EVENTS.dropped, { sessionId, entry: laterView(l) as unknown as Json, why: 'done' });
  }

  /**
   * For later (design/for-later.md), as v1's PATCH /sessions/:id applied it after state and archived:
   * forLater true (or the time it was saved, for Undo) parks it, false unparks it; a state (Mark done,
   * Reopen) or Archive takes it out. A task still working can't be parked.
   */
  async park(r: Runner, sessionId: string, a: { forLater?: unknown; state?: unknown; by?: string }): Promise<{ forLater?: LaterExt['forLater'] }> {
    const s = await new Rt(r).get(sessionId);
    if (!s) throw bad('no such session', 'not_found');
    const n = typeof a.forLater === 'number' && Number.isFinite(a.forLater) ? a.forLater : undefined;
    const park = a.forLater === true || (n !== undefined && n > 0);
    if (park && !free(s)) throw bad('Still working — save it for later once it’s finished.', 'conflict');
    const now = this.#ctx.clock.now();
    const t = this.#rows.editTask(sessionId, (x) => {
      if (a.forLater === false || a.state || s.archived) x.for_later = null;
      if (park && !s.archived) x.for_later = { at: Math.min(n ?? now, now), by: a.by ?? 'user' };
    });
    await this.mirror(r, sessionId);
    return t.for_later ? { forLater: t.for_later } : {};
  }

  /** A due entry goes. force: Send now, whatever the clock says (over a live run it queues behind it). */
  async fire(r: Runner, s: Session, l: LaterEntry, o: { force?: boolean } = {}): Promise<unknown> {
    const now = this.#ctx.clock.now();
    const rt = new Rt(r);
    this.#rows.dropEntries([l.id]);
    if (l.remind) return this.#remind(r, s, l);
    // a goal round that waited for the plan: the goal takes it from here (or it lapsed: dropped, resumed meanwhile)
    if (l.goal !== undefined) {
      await this.mirror(r, s.id);
      const out = await r.run(GOAL.carryOn, { sessionId: s.id, entry: { text: l.text, goal: l.goal } }).catch((e: unknown) => (this.#ctx.log.warn(`later: goal round: ${(e as Error).message}`), null));
      return out ?? { lapsed: true };
    }
    const late = !o.force && now - l.at > LATE_MS;
    this.#rows.editTask(s.id, (x) => void (x.sent = { by: l.by, setAt: l.setAt, at: l.at, ...(late && { late: true as const }) }));
    await this.mirror(r, s.id);
    try {
      const out = await rt.followUp({ id: s.id, text: l.text, attachments: l.attachments ?? [], queue: true, by: 'later' });
      this.#ctx.emit(EVENTS.fired, { sessionId: s.id, entryId: l.id, by: l.by, remind: false });
      return out;
    } catch (e) {
      this.#rows.editTask(s.id, (x) => void (x.sent = null));
      await this.mirror(r, s.id);
      throw e;
    }
  }

  async #remind(r: Runner, s: Session, l: LaterEntry, text = l.text, missed = false): Promise<{ reminded: true }> {
    const rt = new Rt(r);
    const was = s.state === 'running' ? 'review' : s.state;
    this.#rows.editTask(s.id, (x) => {
      x.reminder = { text, at: l.at, setAt: l.setAt, by: l.by, was, ...(missed && { missed: true as const }) };
      x.for_later = null; // it needs you now: out of For later
    });
    if (s.state !== 'running' && s.state !== 'review') await rt.setState(s.id, 'review');
    await rt.markRead(s.id, true);
    if (s.archived) await rt.unarchive(s.id);
    await this.mirror(r, s.id);
    this.#ctx.service<NotifyService>('notify').notice('reminder', { session: { id: s.id, title: s.title, reminder: { text, at: l.at, setAt: l.setAt, by: l.by } } });
    this.#ctx.emit(EVENTS.fired, { sessionId: s.id, entryId: l.id, by: l.by, remind: true });
    return { reminded: true };
  }

  /** A day late: the task comes back to Needs you with the follow-up, unsent. */
  missed(r: Runner, s: Session, l: LaterEntry, when: string): Promise<{ reminded: true }> {
    this.#rows.dropEntries([l.id]);
    return this.#remind(r, s, l, `Missed follow-up (due at ${when}, wisp was off): ${l.text}`, true);
  }

  /** Moved to the reset of the window that holds it back (Automations stop at); Send now still sends it at once. */
  async waitForPlan(r: Runner, l: LaterEntry, h: { why: string; until?: number; load?: boolean }): Promise<void> {
    const now = this.#ctx.clock.now();
    const until = h.until ?? now + 3600_000;
    this.#rows.putEntry({ ...l, at: Math.max(until, now + 60_000), held: { why: h.why, until, ...(h.load && { load: true as const }) } });
    await this.mirror(r, l.sessionId);
  }

  /**
   * A turn started on the task: the follow-up it carries moves onto it (who set it, when), an agent's
   * wake-ups count up until you say something, and new work takes it out of For later and answers a
   * reminder (v1 runner #startTurn). Housekeeping (Compact now) changes nothing.
   */
  async turnStarted(r: Runner, sessionId: string, turnId: string): Promise<void> {
    const t = this.#rows.task(sessionId);
    if (!t) return;
    const turn = await new Rt(r).turn(sessionId, turnId);
    const by = turn?.by;
    const sent = by === 'later' ? t.sent : null;
    if (sent) await new Rt(r).turnExt(sessionId, turnId, sent as unknown as Json);
    this.#rows.editTask(sessionId, (x) => {
      if (sent) {
        x.chain = sent.by !== 'user' ? (x.chain ?? 0) + 1 : null;
        x.sent = null;
      } else if (by !== 'wisp') x.chain = null;
      if (by !== 'compact') {
        x.reminder = null;
        x.for_later = null;
      }
    });
    await this.mirror(r, sessionId);
  }
}
