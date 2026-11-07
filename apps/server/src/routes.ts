// The edge's own routes (v1 routes/meta.js, the parts that are the server itself): the event streams,
// commands, health, status, the API description and folder suggestions. Every other v1 route moved to
// the plugin that owns its feature. Full /api paths here, so tools/check can match them to openapi.json.
import { readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { HttpRequestContext, HttpResult, Json, RouteOptions } from '@wisp/kernel';
import type { Status, StatusPart } from '@wisp-plugin/server-api';
import type { Caller } from './auth.ts';
import type { Handler, Routes } from './http/router.ts';
import { API_VERSION, VERSION } from './meta.ts';
import type { SyncEdge } from './sync.ts';

export interface MetaDeps {
  routes: Routes;
  sync: SyncEdge;
  status: () => readonly StatusPart[];
  lastActivityAt: () => number;
  publicUrl: () => string;
  openapi: () => Json;
}

// The gate for the edge's own reads: every set that may talk to wisp at all holds it (user, agent,
// apikey, preview). /api/cmd is gated by it too: the dispatcher checks each command's own permission.
const READ = 'topic:read';

const raw = (c: HttpRequestContext): { req: IncomingMessage; res: ServerResponse } => c.raw as { req: IncomingMessage; res: ServerResponse };
const caller = (c: HttpRequestContext): Caller => (c.caller.session === undefined ? { set: c.caller.set } : { set: c.caller.set, session: c.caller.session });

/** `~` and `~/x` → the home folder; the rest as typed (v1 util.expandHome). */
export const expandHome = (p: string): string => p.replace(/^~(?=$|[\\/])/, os.homedir());

/** Folder suggestions for the project picker: up to 12 subfolders starting with what was typed. */
export async function folderSuggestions(q: string): Promise<string[]> {
  const typed = expandHome(q);
  const trailing = /[\\/]$/.test(typed); // a trailing backslash counts too (Windows)
  const dir = trailing ? typed : path.dirname(typed);
  const prefix = trailing ? '' : path.basename(typed).toLowerCase();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
      .slice(0, 12)
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** GET /api/status: v1's fields, each feature's from its server.status part. */
export function status(parts: readonly StatusPart[], base: { clients: number; lastActivityAt: number }): Status {
  const out: Status = { live: 0, sides: 0, terms: 0, channels: 0, clients: base.clients, lastActivityAt: base.lastActivityAt || null, nextWakeAt: null, version: VERSION };
  const wakes: number[] = [];
  for (const p of parts) {
    try {
      Object.assign(out, p.fields?.());
      const w = p.nextWakeAt?.();
      if (typeof w === 'number' && w > 0) wakes.push(w);
      const a = p.lastActivityAt?.();
      if (typeof a === 'number' && a > (out.lastActivityAt ?? 0)) out.lastActivityAt = a;
    } catch {
      // one feature failing to say doesn't take the status down: an idle check must still answer
    }
  }
  out.clients = base.clients;
  out.version = VERSION;
  out.nextWakeAt = wakes.length ? Math.min(...wakes) : null;
  return out;
}

export function registerMeta(d: MetaDeps): void {
  const route = (method: string, pattern: string, handler: Handler, opts: RouteOptions): void => void d.routes.add('wisp.server', method, pattern, handler, opts, true);
  const stream = (fn: (c: HttpRequestContext) => void | Promise<void>): Handler => async (c) => {
    await fn(c);
    return { stream: true } satisfies HttpResult;
  };
  route('GET', '/api/events', stream((c) => d.sync.events(raw(c).req, raw(c).res, caller(c))), { permission: READ, summary: 'Server-sent events: the v2 sync stream (?topics&cursor), or v1 events for a v1 client' });
  route('POST', '/api/events', stream((c) => d.sync.message(raw(c).req, raw(c).res, caller(c))), { permission: READ, summary: 'sub, unsub, window and mutate for an open v2 stream (X-Wisp-Client)' });
  route('POST', '/api/cmd', stream((c) => d.sync.cmd(raw(c).req, raw(c).res, caller(c))), { permission: READ, summary: 'Run a command {cmd, args} by Idempotency-Key; the command checks its own permission' });
  route('GET', '/api/health', () => ({ status: 200, json: { ok: true, name: 'wisp', version: VERSION, apiVersion: API_VERSION, pid: process.pid, url: d.publicUrl() } }), { permission: READ, summary: 'Liveness, version and pid' });
  route('GET', '/api/status', () => ({ status: 200, json: status(d.status(), { clients: d.sync.looking(), lastActivityAt: d.lastActivityAt() }) }), { permission: READ, summary: 'Whether anything is going on, to stop an idle wisp' });
  route('GET', '/api/openapi.json', () => ({ status: 200, json: d.openapi() }), { permission: READ, doc: false });
  route('GET', '/api/fs', async (c) => ({ status: 200, json: await folderSuggestions(c.query.get('q') ?? '') }), { permission: 'fs:read', doc: false });
}
