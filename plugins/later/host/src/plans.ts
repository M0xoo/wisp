// Plans: a task or a reminder that doesn't exist yet (v1 later.js plan/editPlan/cancelPlan/#runPlan,
// config.later → later_plan rows). A task plan starts with runtime.create; a reminder plan becomes a
// task of its own with no agent (runtime.card).
import { clock, EVENTS, LaterError, textOf, titleOf, whenOf } from '@wisp-plugin/later-api';
import type { Plan, PlanBody } from '@wisp-plugin/later-api';
import type { Attachment, Mode, StartArgs } from '@wisp-plugin/runtime-api';
import type { Json, NotifyService, PluginContext } from '@wisp/kernel';
import type { Rows } from './rows.ts';
import { Rt } from './rt.ts';
import type { Runner } from './rt.ts';
import { newId } from './tasks.ts';

const bad = (message: string, code = 'invalid'): LaterError => new LaterError(code, message);

export interface PlanArgs {
  kind?: unknown;
  at?: unknown;
  in?: unknown;
  draft?: unknown;
  after?: unknown;
  body?: unknown;
  text?: unknown;
  from?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MODES: readonly string[] = ['plan', 'edits', 'auto'];

/** The launch a task plan keeps, as the runtime takes it: what v1's launch body named that v2 has. */
function startArgs(b: PlanBody, ext: Record<string, Json>): StartArgs {
  const str = (k: string): string | undefined => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
  const out: StartArgs = { prompt: b.prompt, ext };
  for (const k of ['agent', 'model', 'effort', 'cwd', 'title', 'account'] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = v;
  }
  const mode = str('mode');
  if (mode && MODES.includes(mode)) out.mode = mode as Mode;
  if (Array.isArray(b['dirs'])) out.dirs = b['dirs'].filter((d): d is string => typeof d === 'string');
  if (Array.isArray(b['attachments'])) out.attachments = b['attachments'].filter((a): a is Json & Attachment => isObj(a) && typeof a['id'] === 'string' && typeof a['name'] === 'string') as Attachment[];
  return out;
}

export class Plans {
  readonly #ctx: PluginContext;
  readonly #rows: Rows;
  readonly #changed: () => void;

  constructor(ctx: PluginContext, rows: Rows, changed: () => void) {
    this.#ctx = ctx;
    this.#rows = rows;
    this.#changed = changed;
  }

  list(): Plan[] {
    return this.#rows.plans();
  }

  get(id: string): Plan {
    const p = this.#rows.plan(id);
    if (!p) throw bad('Already started, or cancelled.', 'not_found');
    return p;
  }

  /** { kind: 'task', body } or { kind: 'reminder', text, from? }; a task may have draft: true or after: a task id instead of a time. */
  async plan(r: Runner, a: PlanArgs): Promise<Plan> {
    const kind = a.kind;
    if (kind !== 'task' && kind !== 'reminder') throw bad('kind must be task or reminder.');
    if ((a.draft || a.after) && kind !== 'task') throw bad('Only a task can be a draft, or wait for another task.');
    const now = this.#ctx.clock.now();
    const p: Plan = { id: newId(), kind, setAt: now };
    if (a.draft === true) p.draft = true;
    else if (a.after) p.after = await this.#afterOf(r, a.after);
    else p.at = whenOf(a, { now });
    if (kind === 'task') {
      if (!isObj(a.body)) throw bad('body required: the task to start.');
      const { prompt, ...rest } = a.body;
      p.body = { ...(rest as Record<string, Json>), prompt: textOf(prompt, 'prompt') };
      p.title = titleOf(p.body.prompt);
    } else {
      p.text = textOf(a.text, 'What to remind you about');
      if (isObj(a.from) && a.from['id']) p.from = { id: String(a.from['id']).slice(0, 60), title: String(a.from['title'] ?? '').slice(0, 200) };
    }
    this.#rows.putPlan(p);
    this.#changed();
    // already done: it starts now, not on the next look (after this answer, as v1's microtask)
    if (p.after) {
      const id = p.after.id;
      queueMicrotask(() => void this.taskDone(this.#ctx, id).catch((e: unknown) => this.#ctx.log.warn(`later: ${(e as Error).message}`)));
    }
    return p;
  }

  /** after: a task id (or { id }) here, not one still working on another machine. */
  async #afterOf(r: Runner, after: unknown): Promise<{ id: string; title: string }> {
    const id = String(isObj(after) ? after['id'] : after).trim();
    if (!/^[a-zA-Z0-9_-]{2,64}$/.test(id) || id === 'undefined') throw bad('Say which task it waits for: its id.');
    const s = await new Rt(r).get(id);
    if (!s) throw bad('No task with that id here: /after waits for a task on this computer.', 'not_found');
    if (this.#rows.task(id)?.kind === 'reminder') throw bad('That’s a reminder, not a task to wait for.');
    return { id, title: String(s.title || 'Untitled task').slice(0, 200) };
  }

  async editPlan(r: Runner, id: string, body: { at?: unknown; in?: unknown; text?: unknown; prompt?: unknown; now?: unknown }): Promise<unknown> {
    const p = this.get(id);
    if (body.now === true) return this.run(r, p);
    // a time: a draft (or one waiting for a task) is scheduled now instead
    if (body.at !== undefined || body.in !== undefined) {
      p.at = whenOf(body, { now: this.#ctx.clock.now() });
      delete p.draft;
      delete p.after;
      delete p.lost;
    }
    if (body.text !== undefined && p.kind === 'reminder') p.text = textOf(body.text);
    if (body.prompt !== undefined && p.kind === 'task' && p.body) {
      p.body = { ...p.body, prompt: textOf(body.prompt, 'prompt') };
      p.title = titleOf(p.body.prompt);
    }
    this.#rows.putPlan(p);
    this.#changed();
    return p;
  }

  cancelPlan(id: string): boolean {
    const ok = this.#rows.dropPlan(id);
    if (ok) this.#changed();
    return ok;
  }

  /** It starts now: a task launches, a reminder becomes a task of its own. → { session: { id } } */
  async run(r: Runner, p: Plan): Promise<{ session: { id: string } }> {
    this.#rows.dropPlan(p.id);
    this.#changed();
    if (p.kind === 'reminder') return { session: await this.reminderTask(r, p) };
    const origin = { kind: 'later' as const, id: p.id, name: p.draft ? 'Draft' : p.after ? `After ${p.after.title}` : 'Scheduled' };
    try {
      if (!p.body) throw new Error('the plan has no task');
      const { id } = await new Rt(r).create(startArgs(p.body, { 'wisp.later': { origin } }));
      this.#rows.editTask(id, (t) => void (t.origin = origin));
      this.#ctx.emit(EVENTS.planStarted, { planId: p.id, sessionId: id, kind: p.kind });
      return { session: { id } };
    } catch (err) {
      // it couldn't start (the folder went, a harness was removed): say so where you'll see it
      const when = p.draft ? 'from Drafts' : p.after ? `after “${p.after.title}”` : 'at the time you set';
      return { session: await this.reminderTask(r, { ...p, text: `Couldn’t start “${p.title ?? ''}” ${when}: ${(err as Error).message}` }, true) };
    }
  }

  /** A reminder of its own: a finished task with one turn, in Needs you. It has no agent to talk to. */
  async reminderTask(r: Runner, p: Plan, failed = false): Promise<{ id: string }> {
    const now = this.#ctx.clock.now();
    const text = p.text ?? '';
    const title = (text.split('\n')[0] ?? '').slice(0, 120);
    const reminder = { text, at: p.at ?? now, setAt: p.setAt, by: 'user', ...(p.from && { from: p.from }) };
    const summary = failed ? '' : `A reminder you set at ${clock(p.setAt, now)}${p.from ? ` in “${p.from.title}”` : ''}.`;
    const { id } = await new Rt(r).card({
      title, prompt: text, startedAt: p.setAt, blocks: [{ type: 'hero', title, summary, status: failed ? 'blocked' : 'info' }],
      ext: { 'wisp.later': { kind: 'reminder', reminder } },
    });
    this.#rows.editTask(id, (t) => {
      t.kind = 'reminder';
      t.reminder = reminder;
    });
    this.#ctx.service<NotifyService>('notify').notice('reminder', { session: { id, title, reminder } });
    this.#ctx.emit(EVENTS.planStarted, { planId: p.id, sessionId: id, kind: 'reminder' });
    return { id };
  }

  /** The task was marked done (or is): what waited for it starts. Gone, or put away unfinished: a draft. */
  async taskDone(r: Runner, sessionId: string): Promise<number> {
    const waiting = this.#rows.waitingOn(sessionId);
    if (!waiting.length) return 0;
    const s = await new Rt(r).get(sessionId);
    if (!s || s.archived) {
      this.lost(sessionId, s ? 'archived' : 'deleted');
      return 0;
    }
    if (s.state !== 'done') return 0;
    for (const p of waiting) await this.run(r, p).catch((e: unknown) => this.#ctx.log.warn(`later: ${(e as Error).message}`));
    return waiting.length;
  }

  /** Waiting for a task that can't be done any more: it waits in Drafts for you. */
  lost(sessionId: string, why: 'deleted' | 'archived'): void {
    for (const p of this.#rows.waitingOn(sessionId)) {
      if (!p.after) continue;
      const { after, ...rest } = p;
      this.#rows.putPlan({ ...rest, draft: true, lost: { ...after, why } });
    }
    this.#changed();
  }

  /** A task a day overdue isn't started behind your back: it becomes a reminder that it was missed. */
  async missed(r: Runner, p: Plan): Promise<void> {
    this.#rows.dropPlan(p.id);
    const now = this.#ctx.clock.now();
    await this.reminderTask(r, { ...p, text: `Missed: “${p.title ?? ''}” was due at ${clock(p.at ?? now, now)} while wisp was off. Start it again if you still want it.` }, true);
  }
}
