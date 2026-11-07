// v1's terminal routes, kept as they were (method, path, body and answer), as thin adapters:
//
//   GET    /sessions/:id/term        the take over's output as server-sent events
//   POST   /sessions/:id/term        { data, seq?, from? } typed into it, { cols, rows } resized
//   DELETE /sessions/:id/term        close it
//   GET    /sessions/:id/shell       the shell beside the task, as server-sent events (as /term)
//   POST   /sessions/:id/shell       { cols, rows } start it (or { restart }), { data } type, resize
//   DELETE /sessions/:id/shell       end it
//   POST   /sessions/:id/open-shell  the folder in the terminal app from Settings, on this desktop

import type { Session } from '@wisp-plugin/runtime-api';
import { openInTerminal, terminalPlan } from './apps.ts';
import { ptySupported } from './env.ts';
import type { Later } from './order.ts';
import { asObj, type Http, json, type Req, type Result, sseSink } from './ports.ts';
import type { AppSpawner } from './apps.ts';
import type { Terms } from './terms.ts';
import type { Shells } from './shells.ts';

export interface RouteDeps {
  takeovers: Terms;
  shells: Shells;
  /** the session, or null when there's none (404) */
  session(id: string, caller: Req['caller']): Promise<Session | null>;
  platform: string;
  env: Record<string, string | undefined>;
  setting(key: string): string | undefined;
  apps: AppSpawner;
  later: Later;
}

const NO_SESSION = json(404, { error: 'no such session' });

/** A terminal app can open only on a desktop someone sits at, and not for a page that came through the grid's edge. */
export function appHere(d: Pick<RouteDeps, 'platform' | 'env'>, c: Pick<Req, 'headers'>): boolean {
  const viaProxy = c.headers['x-wisp-proxy-secret'] !== undefined || c.headers['x-wisp-proxy-via'] !== undefined;
  const headless = !!d.env['WISP_GRID_URL'] || (d.platform === 'linux' && !d.env['DISPLAY'] && !d.env['WAYLAND_DISPLAY']);
  return !viaProxy && (d.platform === 'win32' || !headless);
}

export function registerRoutes(http: Http, d: RouteDeps): void {
  const one = (fn: (c: Req, s: Session) => Promise<Result> | Result) => async (c: Req): Promise<Result> => {
    const s = await d.session(c.params['id'] ?? '', c.caller);
    return s ? fn(c, s) : NO_SESSION;
  };
  const stream = (terms: { attach(id: string, res: ReturnType<typeof sseSink>): void }) => one((c, s) => (terms.attach(s.id, sseSink(c.raw)), { stream: true }));

  // The take over's terminal (runtime's POST /takeover opens it through the terminal service).
  http.route('GET', '/sessions/:id/term', stream(d.takeovers), { permission: 'session:read', summary: 'A take over terminal’s output, as server-sent events' });
  http.route('POST', '/sessions/:id/term', one(async (c, s) => {
    const body = asObj(await c.body());
    if (!d.takeovers.live(s.id)) return json(404, { error: 'This task has no terminal open.' });
    if (typeof body['data'] === 'string') d.takeovers.input(s.id, body['data'], order(body));
    if (body['cols'] && body['rows']) d.takeovers.resize(s.id, body['cols'], body['rows']);
    return json(200, { ok: true });
  }), { permission: 'terminal:input', summary: 'Type into a take over terminal, or resize it' });
  http.route('DELETE', '/sessions/:id/term', one((_c, s) => json(200, { ok: d.takeovers.close(s.id) })), { permission: 'terminal:close', summary: 'Close a take over terminal' });

  // The shell beside the task.
  http.route('GET', '/sessions/:id/shell', stream(d.shells.terms), { permission: 'session:read', summary: 'The task’s shell, as server-sent events' });
  http.route('POST', '/sessions/:id/shell', one(async (c, s) => shellPost(d, s, asObj(await c.body()))), { permission: 'terminal:shell', summary: 'Start the task’s shell, type into it or resize it' });
  http.route('DELETE', '/sessions/:id/shell', one((_c, s) => json(200, { ok: d.shells.stop(s.id) })), { permission: 'terminal:close', summary: 'End the task’s shell' });
  http.route('POST', '/sessions/:id/open-shell', one(async (c, s) => openApp(d, c, s)), { permission: 'terminal:open', summary: 'Open the task’s folder in the terminal app from Settings' });
}

const order = (b: Record<string, unknown>): { seq?: number; from?: string } => ({
  ...(Number.isInteger(b['seq']) && { seq: Number(b['seq']) }),
  ...(typeof b['from'] === 'string' && { from: b['from'] }),
});

async function shellPost(d: RouteDeps, s: Session, body: Record<string, unknown>): Promise<Result> {
  const sized = !!(body['cols'] && body['rows']);
  if (typeof body['data'] === 'string') {
    if (!d.shells.terms.live(s.id)) return json(404, { error: 'The shell has ended.' });
    d.shells.terms.input(s.id, body['data'], order(body));
    if (sized) d.shells.terms.resize(s.id, body['cols'], body['rows']);
    return json(200, { ok: true });
  }
  if (d.shells.terms.live(s.id) && !body['restart']) {
    if (sized) d.shells.terms.resize(s.id, body['cols'], body['rows']);
    return json(200, { ok: true, started: false });
  }
  if (!ptySupported(d.platform)) return json(400, { error: 'A shell inside wisp needs macOS or Linux on the computer the task runs on.' });
  const out = await d.shells.start(s, { cols: body['cols'], rows: body['rows'], restart: !!body['restart'] });
  return json(200, { ok: true, started: true, dir: out.dir, gone: out.gone });
}

async function openApp(d: RouteDeps, c: Req, s: Session): Promise<Result> {
  const { dir } = await d.shells.folder(s);
  if (!appHere(d, c)) return json(409, { error: 'There’s no terminal app on the computer this task runs on: use the one in the panel.', dir });
  const chosen = d.setting('terminal');
  const terminal = chosen === 'wisp' || !chosen ? 'auto' : chosen; // "In wisp" is the panel itself
  if (d.env['WISP_NO_OPEN'] !== '1') {
    try {
      const plan = terminalPlan({ cwd: dir, argv: d.shells.argv(), terminal, custom: d.setting('terminal.command') ?? '', platform: d.platform, env: d.env });
      openInTerminal(plan, dir, d.apps, d.later);
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json(200, { ok: true, dir });
}
