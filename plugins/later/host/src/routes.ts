// v1's HTTP API for Later, as thin adapters over the commands (routes/sessions.js /sessions/:id/later,
// routes/automations.js /later, routes/internal.js /internal/later). Same methods, paths and bodies.
import { COMMANDS } from '@wisp-plugin/later-api';
import { COMMANDS as RT } from '@wisp-plugin/runtime-api';
import type { Session } from '@wisp-plugin/runtime-api';
import type { HttpRequestContext, HttpResult, HttpService, Json, PluginContext } from '@wisp/kernel';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bodyOf = async (c: HttpRequestContext): Promise<Record<string, unknown>> => {
  const b = await c.body();
  return isObj(b) ? b : {};
};
const ok = (json: unknown, status = 200): HttpResult => ({ status, json: json ?? { ok: true } });

export function registerRoutes(ctx: PluginContext): void {
  const http = ctx.service<HttpService>('http');
  const run = <R>(c: HttpRequestContext, cmd: string, args: unknown): Promise<R> => ctx.run<R>(cmd, args, { caller: c.caller });
  const add = (method: string, path: string, permission: string, fn: (c: HttpRequestContext) => Promise<HttpResult>): void => {
    ctx.scope.add(http.route(method, path, fn, { permission }));
  };
  // a route on one task of this computer: 404 if there is no such task
  const one = (fn: (c: HttpRequestContext, s: Session) => Promise<HttpResult>) => async (c: HttpRequestContext): Promise<HttpResult> => {
    const s = await run<Session>(c, RT.get, { id: c.params['id'] }).catch(() => undefined);
    return s ? fn(c, s) : { status: 404, json: { error: 'no such session' } };
  };

  // POST { at | in, text, remind? }; PATCH { item, at | in, text } or { item, now: true } (Send now),
  // item 'reminder' snoozes one that came due; DELETE ?item=.
  add('POST', '/sessions/:id/later', 'later:add', one(async (c, s) => {
    if (s.agent === 'wisp') return { status: 400, json: { error: 'This is the tour — launch a real wisp to schedule a follow-up.' } };
    const b = await bodyOf(c);
    return ok(await run(c, COMMANDS.add, { ...b, sessionId: s.id, remind: b['remind'] === true, by: 'user' }), 201);
  }));
  add('PATCH', '/sessions/:id/later', 'later:edit', one(async (c, s) => {
    const b = await bodyOf(c);
    return ok(await run(c, COMMANDS.edit, { ...b, sessionId: s.id, item: String(b['item'] ?? '') }));
  }));
  add('DELETE', '/sessions/:id/later', 'later:cancel', one(async (c, s) => {
    const out = await run<{ ok: boolean }>(c, COMMANDS.cancel, { sessionId: s.id, item: c.query.get('item') ?? '' });
    return out.ok ? ok({ ok: true }) : { status: 404, json: { error: 'Already sent, or cancelled.' } };
  }));

  // POST { kind: 'task', at | in, prompt, cwd, agent, … } or { kind: 'reminder', at | in, text, from? };
  // a task with draft: true instead of a time waits in Drafts, with after: <task id> once that's done.
  add('GET', '/later', 'later:plans', async (c) => ok(await run(c, COMMANDS.plans, {})));
  add('POST', '/later', 'later:plan', async (c) => {
    const { kind, at, in: inMin, text, from, draft, after, ...body } = await bodyOf(c);
    const args = kind === 'reminder' ? { kind, at, in: inMin, text, from } : { kind: 'task', at, in: inMin, draft, after, body };
    return ok(await run(c, COMMANDS.plan, args), 201);
  });
  add('PATCH', '/later/:id', 'later:editPlan', async (c) => {
    const out = await run<unknown>(c, COMMANDS.editPlan, { ...(await bodyOf(c)), id: c.params['id'] });
    const started = isObj(out) && isObj(out['session']) ? String(out['session']['id']) : undefined;
    if (!started) return ok(out);
    // v1 answered with the task it started
    const s = await run<Session>(c, RT.get, { id: started }).catch(() => ({ id: started }));
    return ok({ session: s as unknown as Json });
  });
  add('DELETE', '/later/:id', 'later:cancelPlan', async (c) => {
    const out = await run<{ ok: boolean }>(c, COMMANDS.cancelPlan, { id: c.params['id'] });
    return out.ok ? ok({ ok: true }) : { status: 404, json: { error: 'Already started, or cancelled.' } };
  });

  // resume_later from an agent's MCP server: the caller's token speaks for its session only
  add('POST', '/internal/later', 'later:agent.schedule', async (c) => {
    const out = await run<{ text?: string; error?: string }>(c, COMMANDS.agentSchedule, await bodyOf(c));
    if (out.error === 'bad token') return { status: 403, json: { error: out.error } };
    if (out.error === 'no such session') return { status: 404, json: { error: out.error } };
    return out.error ? { status: 400, json: { error: out.error } } : ok(out);
  });
}
