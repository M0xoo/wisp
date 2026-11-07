// v1's HTTP API for connectors (routes/connectors.js), as thin adapters over the commands: same
// methods, paths, bodies and answers. Each route names the permission its command checks.

import type { Disposable, HttpRequestContext, HttpResult, HttpService, Json, PluginContext } from '@wisp/kernel';
import { COMMANDS } from '@wisp-plugin/connectors-api';

const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const perm = (cmd: string): string => cmd.replace(/^connectors\./, 'connectors:');

/** what a thrown error answers with: v1's `{ error }` and its status */
function failed(e: unknown): HttpResult {
  const err = e as { status?: number; code?: string; message?: string };
  const status = err.status ?? ({ not_found: 404, invalid: 400, forbidden: 403, vetoed: 403, conflict: 409, unavailable: 502 } as Record<string, number>)[err.code ?? ''] ?? 500;
  return { status, json: { error: String(err.message ?? e) } };
}

const obj = async (c: HttpRequestContext): Promise<Record<string, unknown>> => {
  const b = await c.body();
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

export function registerRoutes(ctx: PluginContext): Disposable[] {
  const http = ctx.service<HttpService>('http');
  const run = (cmd: string, args: unknown, c: HttpRequestContext): Promise<unknown> => ctx.run(cmd, args, { caller: c.caller });
  const out: Disposable[] = [];
  const route = (method: string, path: string, cmd: string, args: (c: HttpRequestContext) => Promise<unknown> | unknown, o: { status?: number; doc?: boolean } = {}): void => {
    out.push(
      http.route(
        method,
        path,
        async (c) => {
          try {
            return { status: o.status ?? 200, json: (await run(cmd, await args(c), c)) as Json };
          } catch (e) {
            return failed(e);
          }
        },
        { permission: perm(cmd), ...(o.doc === false && { doc: false }) },
      ),
    );
  };
  const id = (c: HttpRequestContext): string => c.params['id'] ?? '';

  route('GET', '/connectors', COMMANDS.list, () => ({}));
  route('POST', '/connectors', COMMANDS.add, obj, { status: 201 });
  route('PATCH', '/connectors/:id', COMMANDS.update, async (c) => ({ ...(await obj(c)), id: id(c) }));
  route('DELETE', '/connectors/:id', COMMANDS.remove, (c) => ({ id: id(c) }));
  route('POST', '/connectors/:id/test', COMMANDS.test, (c) => ({ id: id(c) }));
  route('POST', '/connectors/import', COMMANDS.import, obj);
  route('POST', '/connectors/:id/signin', COMMANDS.signin, async (c) => ({ id: id(c), origin: (await obj(c))['origin'] }));
  route('DELETE', '/connectors/:id/signin', COMMANDS.signout, (c) => ({ id: id(c) }));
  // The proxy asks for a token that works (wisp refreshes it if needed), and for what it runs.
  route('POST', '/internal/connectors/:id/token', COMMANDS.token, async (c) => ({ id: id(c), force: !!(await obj(c))['force'] }), { doc: false });
  route('POST', '/internal/connectors/:id/spec', COMMANDS.spec, (c) => ({ id: id(c) }), { doc: false });

  // Where the sign-in page sends the browser back: a page that says how it went and closes.
  out.push(
    http.route(
      'GET',
      '/connectors/oauth/callback',
      async (c) => {
        let title: string;
        let text: string;
        try {
          const x = (await run(COMMANDS.oauthFinish, { query: Object.fromEntries(c.query) }, c)) as { name: string };
          title = `Signed in to ${x.name}`;
          text = 'Back in wisp, its tools are ready for your tasks. You can close this tab.';
        } catch (err) {
          title = 'Couldn’t sign in';
          text = (err as Error).message;
        }
        return {
          status: 200,
          type: 'text/html; charset=utf-8',
          text: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · wisp</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:380px;padding:24px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 6px}p{margin:0;opacity:.7}</style>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p></main><script>setTimeout(() => window.close(), 1500)</script>`,
        };
      },
      { permission: perm(COMMANDS.oauthFinish), doc: false },
    ),
  );

  // The agent's tools, for v1's mcp-ask: answers are 200 with { error } or { text }, as the tool reads them.
  const tool = (method: string, path: string, cmd: string): void => {
    out.push(
      http.route(
        method,
        path,
        async (c) => {
          const sid = c.params['sid'] ?? '';
          // A session's token speaks for that session only (v1 speaksFor).
          if (c.caller.session && c.caller.session !== sid) return { status: 403, json: { error: 'bad token' } };
          try {
            return { status: 200, json: (await ctx.run(cmd, method === 'GET' ? {} : await obj(c), { caller: { ...c.caller, session: sid } })) as Json };
          } catch (e) {
            const error = String((e as Error).message ?? e);
            return { status: 200, json: (e as { code?: string }).code === 'forbidden' ? { error, text: error } : { error } };
          }
        },
        { permission: perm(cmd), doc: false },
      ),
    );
  };
  tool('GET', '/internal/connectors/:sid', COMMANDS.agentList);
  tool('POST', '/internal/connectors/:sid', COMMANDS.agentAdd);
  tool('POST', '/internal/connectors/:sid/signin', COMMANDS.agentSignin);
  return out;
}
