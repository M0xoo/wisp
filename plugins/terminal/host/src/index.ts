// wisp.terminal: terminals for the page (v1 server/pty.js, server/terminal.js and the terminal routes
// of routes/sessions.js and routes/workspace.js). Two registries, take overs and shells, on the
// kernel's proc service with a PTY; the flow of each terminal is flow.ts.

import os from 'node:os';
import type { CallContext, PluginContext, Verdict } from '@wisp/kernel';
import { COMMANDS as RUNTIME, EVENTS as RUNTIME_EVENTS, HOOKS, POINTS as RUNTIME_POINTS, type FollowUpArgs, type Session, type SummaryField } from '@wisp-plugin/runtime-api';
import { BUSY_MESSAGE, COMMANDS, EVENTS, type FolderSource, POINTS, TERMINAL, type TermInfo, type TermKind, type TerminalService } from '@wisp-plugin/terminal-api';
import type { AppSpawner } from './apps.ts';
import { asObj, type Http } from './ports.ts';
import { registerRoutes } from './routes.ts';
import { Shells } from './shells.ts';
import { type PtySpawner, Terms } from './terms.ts';
import { laterIn } from './timers.ts';

// @wisp/kernel's definePlugin, once its index exports one; the shape is the PluginDef contract.
const definePlugin = <T extends { id: string; setup(ctx: PluginContext): void | Promise<void> }>(d: T): T => d;

export interface TerminalPlugin {
  takeovers: Terms;
  shells: Shells;
}

/** Everything setup builds, without the kernel: the tests drive this directly. */
export function createTerminals(o: { proc: PtySpawner; env: Record<string, string | undefined>; later: ReturnType<typeof laterIn>; home: string; sources: () => readonly FolderSource[]; onChange: (i: TermInfo | { id: string; kind: TermKind; state: 'gone' }) => void; now?: () => number }): TerminalPlugin {
  const base = { proc: o.proc, env: o.env, later: o.later, onChange: o.onChange, ...(o.now && { now: o.now }) };
  const takeovers = new Terms({ ...base, kind: 'takeover' });
  const shells = new Shells(new Terms({ ...base, kind: 'shell' }), o.sources, o.env, o.home);
  return { takeovers, shells };
}

function service(t: TerminalPlugin): TerminalService {
  const reg = (k: TermKind): Terms => (k === 'takeover' ? t.takeovers : t.shells.terms);
  return {
    open: async (k, id, a) => reg(k).open(id, a),
    get: async (k, id) => reg(k).info(id),
    input: async (k, id, data, order) => reg(k).input(id, data, order),
    resize: async (k, id, cols, rows) => reg(k).resize(id, cols, rows),
    close: async (k, id) => reg(k).close(id),
    active: async () => t.takeovers.active() + t.shells.terms.active(),
  };
}

const kindOf = (v: unknown): TermKind => (v === 'shell' ? 'shell' : 'takeover');

function commands(ctx: PluginContext, t: TerminalPlugin, svc: TerminalService, get: (id: string, c: CallContext) => Promise<Session>): void {
  ctx.command({ id: COMMANDS.open, run: (a: unknown) => {
    const b = asObj(a);
    const argv = Array.isArray(b['argv']) ? b['argv'].map(String) : [];
    return svc.open(kindOf(b['kind']), String(b['id'] ?? ''), { argv, cwd: String(b['cwd'] ?? ''), cols: Number(b['cols']) || 100, rows: Number(b['rows']) || 30, tui: b['tui'] === true });
  } });
  ctx.command({ id: COMMANDS.input, run: async (a: unknown) => {
    const b = asObj(a);
    const k = kindOf(b['kind']);
    const id = String(b['id'] ?? '');
    const ok = typeof b['data'] === 'string' ? await svc.input(k, id, b['data']) : true;
    if (b['cols'] && b['rows']) await svc.resize(k, id, Number(b['cols']), Number(b['rows']));
    return { ok };
  } });
  ctx.command({ id: COMMANDS.close, run: async (a: unknown) => ({ ok: await svc.close(kindOf(asObj(a)['kind']), String(asObj(a)['id'] ?? '')) }) });
  ctx.command({ id: COMMANDS.shellStart, run: async (a: unknown, c: CallContext) => {
    const b = asObj(a);
    const s = await get(String(b['id'] ?? ''), c);
    if (t.shells.terms.live(s.id) && !b['restart']) return { ok: true, started: false };
    const f = await t.shells.start(s, { cols: b['cols'], rows: b['rows'], restart: !!b['restart'] });
    return { ok: true, started: true, dir: f.dir, gone: f.gone };
  } });
}

export default definePlugin({
  id: 'wisp.terminal',
  setup(ctx: PluginContext) {
    const later = laterIn(ctx.scope);
    const env = process.env;
    const t = createTerminals({
      proc: ctx.service<PtySpawner>('proc'), env, later, home: os.homedir(),
      sources: () => ctx.contributions<FolderSource>(POINTS.folder),
      onChange: (i) => ctx.emit(EVENTS.changed, { kind: i.kind, id: i.id, state: i.state, code: 'code' in i ? i.code : null }),
    });
    ctx.scope.add(() => (t.takeovers.closeAll(), t.shells.terms.closeAll()));
    const svc = service(t);
    ctx.provide(TERMINAL, svc);
    const get = (id: string, c: Pick<CallContext, 'run'>): Promise<Session> => c.run<Session>(RUNTIME.get, { id });
    commands(ctx, t, svc, get);

    // The list row says "In terminal" while a take over runs (v1 summary.term).
    ctx.contribute<SummaryField>(RUNTIME_POINTS.summary, { plugin: 'wisp.terminal', fields: (s) => (t.takeovers.live(s.id) ? { term: true } : {}) });
    // Two agents on one conversation would trample each other: a follow-up waits for the terminal to end.
    ctx.intercept<FollowUpArgs>({ hook: HOOKS.beforeFollowUp, run: (a): Verdict<FollowUpArgs> => {
      const info = t.takeovers.info(a.id);
      return t.takeovers.live(a.id) && !info?.tui ? { kind: 'veto', code: 'conflict', message: BUSY_MESSAGE } : { kind: 'continue' };
    } });
    // A deleted task takes its terminals with it; an archived one its shell (v1 routes/sessions.js).
    ctx.on<{ id: string }>(RUNTIME_EVENTS.deleted, (e) => void (t.takeovers.close(e.data.id), t.shells.stop(e.data.id)));
    ctx.on<{ id: string }>(RUNTIME_EVENTS.changed, async (e) => {
      if (!t.shells.terms.info(e.data.id)) return; // the common case costs one map lookup
      const s = await ctx.run<Session>(RUNTIME.get, { id: e.data.id }).catch(() => null);
      if (!s || s.archived) t.shells.stop(e.data.id);
    });

    registerRoutes(ctx.service<Http>('http'), {
      takeovers: t.takeovers, shells: t.shells, platform: process.platform, env, later,
      session: (id, caller) => ctx.run<Session>(RUNTIME.get, { id }, { caller: { set: caller.set, ...(caller.session && { session: caller.session }) } }).catch(() => null),
      setting: (k) => {
        const v = ctx.settings.get(k);
        return typeof v === 'string' ? v : undefined;
      },
      apps: ctx.service<AppSpawner>('proc'),
    });
  },
});

export { openapi } from './openapi.ts';
