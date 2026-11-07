// v1's HTTP API for channels, as thin adapters over the commands (routes/settings.js's /remote and
// routes/channels.js). Same methods, paths, bodies and answers: older phone apps, the SDK and wisp
// Grid keep working. Who may reach the grid's two doors is the caller's set, which only the edge can
// give: `grid:inbox` (a held message, x-wisp-proxy-via: inbox behind the grid's proxy mark) and
// `grid:route` (a routed one, through the tunnel, x-wisp-route: grid).

import type { Caller, Disposable, HttpRequestContext, HttpResult, HttpService, PluginContext } from '@wisp/kernel';
import { COMMANDS } from '@wisp-plugin/channels-api';

export const CHANNEL_INBOUND = '/api/channels/inbound';
const STATUS: Record<string, number> = { invalid: 400, forbidden: 403, vetoed: 403, not_found: 404, conflict: 409, timeout: 504, unavailable: 503 };

/** A thrown error as v1 answered it: { error } with its status. */
export function errorResult(err: unknown): HttpResult {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; message?: unknown; details?: { status?: unknown } };
  const status = typeof e.status === 'number' ? e.status : typeof e.details?.status === 'number' ? e.details.status : STATUS[String(e.code)] ?? 500;
  return { status, json: { error: typeof e.message === 'string' ? e.message : String(err) } };
}

const asCaller = (c: HttpRequestContext): Caller => ({ set: c.caller.set, ...(c.caller.session && { session: c.caller.session }) });
const header = (c: HttpRequestContext, name: string): string => {
  const v = c.headers[name];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
};

/** Runs `after` once the answer has gone out (the grid must hear the 2xx first). */
function whenSent(c: HttpRequestContext, ctx: PluginContext, after: () => void): void {
  const res = c.raw.res as { once?: (ev: string, fn: () => void) => void; writableFinished?: boolean } | undefined;
  if (res && typeof res.once === 'function') res.once('finish', after);
  else ctx.scope.timeout(0, after);
}

export function registerRoutes(ctx: PluginContext, http: HttpService, afters: Map<string, () => void>): Disposable[] {
  const run = async (c: HttpRequestContext, cmd: string, args: unknown, ok = 200): Promise<HttpResult> => {
    try {
      return { status: ok, json: await ctx.run(cmd, args, { caller: asCaller(c) }) };
    } catch (err) {
      return errorResult(err);
    }
  };
  const answered = async (c: HttpRequestContext, cmd: string, args: unknown): Promise<HttpResult> => {
    try {
      const out = await ctx.run<{ status: number; body: unknown; after?: string }>(cmd, args, { caller: asCaller(c) });
      const after = out.after ? afters.get(out.after) : undefined;
      if (out.after) afters.delete(out.after);
      if (after) whenSent(c, ctx, after);
      return { status: out.status, json: out.body };
    } catch (err) {
      return errorResult(err);
    }
  };
  const body = async (c: HttpRequestContext): Promise<Record<string, unknown>> => {
    const b = await c.body().catch(() => ({}));
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  };
  return [
    http.route('GET', '/remote', (c) => run(c, COMMANDS.view, {}), { permission: 'channels:view', summary: 'Channels: config with secrets masked, plus health' }),
    http.route('PUT', '/remote', async (c) => run(c, COMMANDS.update, await body(c)), { permission: 'channels:update', summary: 'Change channels; masked tokens mean unchanged' }),
    http.route('POST', '/remote/test', (c) => run(c, COMMANDS.test, {}), { permission: 'channels:test', summary: 'Send a test message to the phone' }),
    http.route('GET', '/remote/:channel/:what', (c) => run(c, COMMANDS.extra, { channel: c.params['channel'], what: c.params['what'] }), { permission: 'channels:view', summary: 'A transport’s extra (Slack’s manifest, Discord’s invite)' }),
    // A channel's message that wisp Grid held while this box slept. Only the grid's delivery has the
    // mark, which the edge strips from everything else; the channel then verifies the message itself.
    http.route('POST', '/channels/inbound', async (c) => {
      if (c.caller.set !== 'grid:inbox' || header(c, 'x-wisp-proxy-via') !== 'inbox') return { status: 403, json: { error: 'From wisp Grid only.' } };
      return answered(c, COMMANDS.inbound, await body(c));
    }, { permission: 'channels:inbound', summary: 'A channel message wisp Grid held for this box' }),
    // A message the grid routed to this computer, through its tunnel only.
    http.route('POST', '/channels/routed', async (c) => {
      if (c.caller.set !== 'grid:route' || header(c, 'x-wisp-route') !== 'grid') return { status: 403, json: { error: 'From wisp Grid only.' } };
      return answered(c, COMMANDS.routed, await body(c));
    }, { permission: 'channels:routed', summary: 'A message wisp Grid routed to this computer' }),
    // A channel URL that leaked: Settings has nothing for this yet, it's for the API and the agent.
    http.route('POST', '/channels/rotate', async (c) => answered(c, COMMANDS.rotate, await body(c)), { permission: 'channels:rotate', summary: 'Replace this cloud wisp’s inbound URL for a channel' }),
  ];
}
