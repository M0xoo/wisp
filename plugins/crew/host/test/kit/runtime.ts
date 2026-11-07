// A fake wisp.runtime for plugin tests: the runtime-api commands over sessions kept in memory. A
// create or follow-up runs before:create / before:run like the real runtime and leaves the turn
// running; the test ends it with `finish()`, which emits turn.finished with the contributed summary.
import { COMMANDS, EVENTS, HOOKS, POINTS } from '@wisp-plugin/runtime-api';
import type { BeforeRunCtx, FollowUpArgs, Presentation, QueueItem, QuickArgs, QuickResult, Session, SessionId, StartArgs, Summary, SummaryField, Turn, TurnId, TurnStatus } from '@wisp-plugin/runtime-api';
import type { CallContext, Json, PluginContext } from '@wisp/kernel';
import { KitError } from './host.ts';
import type { TestHost } from './host.ts';

export interface FinishOptions {
  text?: string;
  blocks?: Presentation['blocks'];
  status?: TurnStatus;
  isError?: boolean;
  costUsd?: number;
  interrupted?: boolean;
  /** the session's state after the turn (default: 'review' when done, 'error' when it failed) */
  state?: Session['state'];
}

export class FakeRuntime {
  readonly sessions = new Map<string, Session>();
  readonly turns = new Map<string, Turn[]>();
  /** every run's before:run verdict, in order: the hold or veto it got, or 'ran' */
  readonly runs: { sessionId: string; outcome: 'ran' | 'held' | 'vetoed'; reason?: string; ctx: BeforeRunCtx }[] = [];
  /** answers runtime.quick (goal judges, Retro); every call is kept in `quickCalls` */
  quick: (a: QuickArgs) => QuickResult | Promise<QuickResult> = () => ({ text: '', json: null, agent: 'claude', model: 'haiku' });
  readonly quickCalls: QuickArgs[] = [];
  #n = 0;
  readonly #host: TestHost;

  constructor(host: TestHost) {
    this.#host = host;
  }

  /** load it into the host: `await new FakeRuntime(host).install()` */
  async install(): Promise<this> {
    await this.#host.load({ id: 'wisp.runtime', setup: (ctx) => this.#setup(ctx) });
    return this;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  last(id: string): Turn | undefined {
    return this.turns.get(id)?.at(-1);
  }
  all(): Session[] {
    return [...this.sessions.values()];
  }

  summary(s: Session): Summary {
    const turns = this.turns.get(s.id) ?? [];
    const last = turns.at(-1);
    const base: Summary = {
      id: s.id, title: s.title, agent: s.agent, model: s.model, effort: s.effort, mode: s.mode, cwd: s.cwd, state: s.state,
      status: last?.status === 'held' ? 'held' : s.state === 'running' ? 'running' : 'done', unread: s.unread, archived: s.archived,
      createdAt: s.createdAt, updatedAt: s.updatedAt, turnCount: turns.length, queued: s.queue.length, preview: last?.text ?? '', live: '',
      ...(s.parentId && { parentId: s.parentId }),
    };
    for (const f of this.#host.contributions<SummaryField>(POINTS.summary)) Object.assign(base, f.fields(s, last));
    return base;
  }

  /** ends the running turn of `id` and tells everyone */
  async finish(id: string, o: FinishOptions = {}): Promise<Turn> {
    const s = this.sessions.get(id);
    const t = this.last(id);
    if (!s || !t) throw new Error(`no turn on ${id}`);
    t.status = o.status ?? (o.isError ? 'error' : 'done');
    t.endedAt = this.#host.clock.now();
    t.text = o.text ?? '';
    t.isError = !!o.isError;
    t.presentation = o.blocks ? { blocks: o.blocks, v: 1 } : null;
    t.stats = o.costUsd === undefined ? null : { costUsd: o.costUsd };
    s.state = o.state ?? (t.status === 'error' ? 'error' : 'review');
    s.updatedAt = t.endedAt;
    this.#host.emit(EVENTS.finished, { sessionId: s.id, turnId: t.id, status: t.status, interrupted: !!o.interrupted, summary: this.summary(s) });
    await this.#host.flush();
    // a queued follow-up goes next, as the runner sends it
    const next = s.queue.shift();
    if (next && !s.queueHeld && !o.interrupted) await this.#turn(this.#host.rootCall('wisp.runtime'), s, next.text, next.by);
    return t;
  }

  #setup(ctx: PluginContext): void {
    const cmd = <A, R>(id: string, run: (a: A, call: CallContext) => R | Promise<R>, readOnly = false): void =>
      ctx.command<A, R>({ id, permission: `runtime:${id.slice('runtime.'.length)}`, readOnly, run });
    cmd<StartArgs, { id: string }>(COMMANDS.create, (a, call) => this.#create(a, call));
    cmd<FollowUpArgs, { turnId?: string; queued?: string }>(COMMANDS.followUp, (a, call) => this.#followUp(a, call));
    cmd<QuickArgs, QuickResult>(COMMANDS.quick, (a) => {
      this.quickCalls.push(a);
      return this.quick(a);
    });
    cmd<{ id: string }, Session>(COMMANDS.get, (a) => structuredClone(this.#must(a.id)), true);
    cmd<{ archived?: boolean; limit?: number }, Summary[]>(COMMANDS.list, (a) => this.all().filter((s) => a.archived === undefined || s.archived === a.archived).slice(0, a.limit ?? 1e9).map((s) => this.summary(s)), true);
    cmd<{ id: string }, Turn[]>(COMMANDS.turns, (a) => structuredClone(this.turns.get(a.id) ?? []), true);
    cmd<{ id: string; plugin: string; value: Json }, Record<string, never>>(COMMANDS.setExt, (a) => {
      const s = this.#must(a.id);
      if (a.value === null) delete s.ext[a.plugin];
      else s.ext[a.plugin] = structuredClone(a.value);
      this.#changed(s);
      return {};
    });
    cmd<{ id: string }, Record<string, never>>(COMMANDS.stop, (a) => {
      const t = this.last(a.id);
      if (t?.status === 'running') void this.finish(a.id, { status: 'stopped', interrupted: true, state: 'review' });
      return {};
    });
    cmd<{ id: string; archived: boolean }, Record<string, never>>(COMMANDS.archive, (a) => this.#set(a.id, { archived: a.archived }));
    cmd<{ id: string; state: Session['state'] }, Record<string, never>>(COMMANDS.setState, (a) => this.#set(a.id, { state: a.state }));
    cmd<{ id: string; unread: boolean }, Record<string, never>>(COMMANDS.markRead, (a) => this.#set(a.id, { unread: a.unread }));
    cmd<{ id: string; title: string }, Record<string, never>>(COMMANDS.rename, (a) => this.#set(a.id, { title: a.title }));
    cmd<{ id: string }, Record<string, never>>(COMMANDS.delete, (a) => {
      this.sessions.delete(a.id);
      this.turns.delete(a.id);
      this.#host.emit(EVENTS.deleted, { id: a.id });
      return {};
    });
    cmd<{ id: string; items: QueueItem[] }, Record<string, never>>(COMMANDS.queueEdit, (a) => {
      this.#must(a.id).queue = a.items;
      return {};
    });
  }

  #must(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new KitError('not_found', `no task ${id}`);
    return s;
  }
  #set(id: string, patch: Partial<Session>): Record<string, never> {
    const s = this.#must(id);
    Object.assign(s, patch);
    this.#changed(s);
    return {};
  }
  #changed(s: Session): void {
    s.updatedAt = this.#host.clock.now();
    this.#host.emit(EVENTS.changed, { id: s.id });
  }

  async #create(args: StartArgs, call: CallContext): Promise<{ id: string }> {
    const a = await call.runHook<StartArgs>(HOOKS.beforeCreate, args);
    const now = this.#host.clock.now();
    const id = `s${++this.#n}` as SessionId;
    const s: Session = {
      id, title: a.title ?? a.prompt.slice(0, 60), agent: a.agent ?? 'claude', model: a.model ?? '', effort: a.effort ?? '', mode: a.mode ?? 'edits',
      cwd: a.cwd ?? '/repo', dirs: a.dirs ?? [], state: 'running', unread: false, archived: false, createdAt: now, updatedAt: now, queue: [],
      ext: structuredClone(a.ext ?? {}), ...(a.parentId && { parentId: a.parentId }), ...(a.account && { account: a.account }),
    };
    this.sessions.set(id, s);
    this.turns.set(id, []);
    this.#host.emit(EVENTS.created, { session: this.summary(s) });
    await this.#turn(call, s, a.prompt, a.by);
    return { id };
  }

  async #followUp(args: FollowUpArgs, call: CallContext): Promise<{ turnId?: string; queued?: string }> {
    const a = await call.runHook<FollowUpArgs>(HOOKS.beforeFollowUp, args);
    const s = this.#must(a.id);
    if (a.queue && this.last(s.id)?.status === 'running') {
      const item: QueueItem = { id: `q${++this.#n}`, text: a.text, attachments: a.attachments ?? [], at: this.#host.clock.now(), ...(a.by && { by: a.by }) };
      s.queue.push(item);
      this.#changed(s);
      return { queued: item.id };
    }
    return { turnId: await this.#turn(call, s, a.text, a.by) };
  }

  async #turn(call: CallContext, s: Session, prompt: string, by?: string): Promise<string> {
    const list = this.turns.get(s.id) ?? [];
    const t: Turn = {
      id: `${s.id}t${list.length + 1}` as TurnId, sessionId: s.id, idx: list.length, prompt, agent: s.agent, model: s.model, effort: s.effort, mode: s.mode,
      attachments: [], status: 'running', startedAt: this.#host.clock.now(), endedAt: null, stats: null, presentation: null, ext: {}, ...(by && { by }),
    };
    list.push(t);
    this.turns.set(s.id, list);
    s.state = 'running';
    const ctx: BeforeRunCtx = { sessionId: s.id, turnId: t.id, agent: s.agent, model: s.model, mode: s.mode, cwd: s.cwd, prompt, ...(by && { by }), ...(s.account && { account: s.account }) };
    try {
      const out = await call.runHook<BeforeRunCtx>(HOOKS.beforeRun, ctx);
      if (out.hold) {
        t.status = 'held';
        t.held = out.hold;
        this.runs.push({ sessionId: s.id, outcome: 'held', ctx: out });
        this.#host.emit(EVENTS.held, { sessionId: s.id, turnId: t.id, by: out.hold.by, kind: out.hold.kind });
      } else {
        this.runs.push({ sessionId: s.id, outcome: 'ran', ctx: out });
        this.#host.emit(EVENTS.started, { sessionId: s.id, turnId: t.id });
      }
    } catch (e) {
      // a veto: the turn never ran, as the real runtime records it
      t.status = 'error';
      t.isError = true;
      t.text = (e as Error).message;
      t.endedAt = this.#host.clock.now();
      s.state = 'error';
      this.runs.push({ sessionId: s.id, outcome: 'vetoed', reason: (e as Error).message, ctx });
      throw e;
    }
    return t.id;
  }
}
