// The API description (v1 server/openapi.js), assembled: the edge's own paths, v1's shared schemas
// (components, so a plugin's `$ref: '#/components/schemas/StuffItem'` still resolves), and each
// plugin's `openapi` export. A plugin exports either a paths object ({ '/api/x': { get } }) or a
// fragment ({ paths, components }). apps/server/openapi.json is this, written by `npm run openapi`
// (scripts/openapi.ts) so tools/check can read it; a test keeps the file and the code equal.
import type { Json } from '@wisp/kernel';
import components from './openapi-components.json' with { type: 'json' };

export type Doc = { [k: string]: Json };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const json = (schema: Json, description = 'OK'): Json => ({ description, content: { 'application/json': { schema } } });
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const stream: Json = { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } };

/** The edge's own paths (src/routes.ts). */
export const EDGE_PATHS: Doc = {
  '/api/health': { get: { summary: 'Liveness, version and pid', responses: { 200: json(ref('Health')) } } },
  '/api/status': {
    get: {
      summary: 'Whether anything is going on: turns running (live), side questions (sides), open terminals (terms), channels still answering a message (channels), open pages (clients), lastActivityAt, and nextWakeAt (the next scheduled wake-up). Used to stop an idle wisp',
      responses: { 200: json({ type: 'object', properties: { live: { type: 'integer' }, sides: { type: 'integer' }, terms: { type: 'integer' }, channels: { type: 'integer' }, clients: { type: 'integer' }, lastActivityAt: { type: ['integer', 'null'] }, nextWakeAt: { type: ['integer', 'null'] }, version: { type: 'string' } } }) },
    },
  },
  '/api/events': {
    get: { summary: 'Server-sent events. With ?topics&cursor (and the other hello keys): the v2 sync stream of topics resumed by cursor. Without: the v1 events (summary, activity, turn, finished, removed, config, preferences, agents, stuff, ping)', responses: { 200: stream } },
    post: { summary: 'Messages for an open v2 stream, named by X-Wisp-Client: sub, unsub, window, mutate', responses: { 202: { description: 'Accepted' }, 403: json(ref('Error')), 404: json(ref('Error')) } },
  },
  '/api/cmd': {
    post: {
      summary: 'Run a command { cmd, args } once per Idempotency-Key (a retry gets the first answer). Answers { ok: true, seq, result } or { ok: false, error: { code, message, retry } }',
      parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 128 } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' }, args: {} } } } } },
      responses: { 200: json({ type: 'object' }), 400: json({ type: 'object' }), 403: json({ type: 'object' }), 409: json({ type: 'object' }) },
    },
  },
  '/api/openapi.json': { get: { summary: 'This document', 'x-wisp-internal': true, responses: { 200: json({ type: 'object' }) } } },
  '/api/fs': { get: { summary: 'Folder suggestions for the project picker (?q=)', 'x-wisp-internal': true, responses: { 200: json({ type: 'array', items: { type: 'string' } }) } } },
};

const DESCRIPTION =
  'Local API of wisp, a launcher and queue for coding agents (Claude Code, Codex, opencode, Cursor, Antigravity, Grok, Copilot). ' +
  'Binds to 127.0.0.1 only. Requests must carry a Host of 127.0.0.1/localhost:<port>; non-GET requests must be ' +
  'application/json (uploads: application/octet-stream) and, if they send an Origin, a local one. ' +
  'The running server advertises { url, port, pid, version } in ~/.wisp/server.json. ' +
  'Behind a reverse proxy (wisp Grid), WISP_TRUSTED_PROXY_SECRET turns on trusted-proxy mode: requests carrying it in ' +
  'x-wisp-proxy-secret may use any Host, and a non-GET Origin must match WISP_PUBLIC_URL. ' +
  'A cloud wisp takes scripts at https://<handle>.<domain>/api/… with Authorization: Bearer wgk_…, an API key made in Settings. ' +
  'Errors answer { error } (v1) together with { code, message, retry }.';

/** Merge a plugin's export into the document; a later plugin's path adds verbs, never replaces one. */
function merge(doc: { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } }, part: unknown): void {
  if (!isObj(part)) return;
  const paths = isObj(part['paths']) ? part['paths'] : part;
  for (const [p, item] of Object.entries(paths)) {
    if (!p.startsWith('/') || !isObj(item)) continue;
    const at = (doc.paths[p] ??= {});
    for (const [verb, op] of Object.entries(item)) if (!(verb in at)) at[verb] = op;
  }
  const comps = isObj(part['components']) && isObj(part['components']['schemas']) ? part['components']['schemas'] : {};
  for (const [k, v] of Object.entries(comps)) doc.components.schemas[k] ??= v;
}

export function openapiDoc(opts: { version: string; port: number; parts: readonly unknown[] }): Json {
  const doc = { paths: {} as Record<string, Record<string, unknown>>, components: { schemas: { ...(components.schemas as Record<string, unknown>) } } };
  merge(doc, EDGE_PATHS);
  for (const p of opts.parts) merge(doc, p);
  const sorted = Object.fromEntries(Object.entries(doc.paths).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.parse(
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'wisp', version: opts.version, description: DESCRIPTION },
      servers: [{ url: `http://127.0.0.1:${opts.port}` }],
      paths: sorted,
      components: doc.components,
    }),
  ) as Json;
}

/** "GET /api/x/{}" keys of a document, for the every-route-is-documented check. */
export function documented(doc: Json): Set<string> {
  const out = new Set<string>();
  const paths = isObj(doc) && isObj(doc['paths']) ? doc['paths'] : {};
  for (const [p, item] of Object.entries(paths)) if (isObj(item)) for (const verb of Object.keys(item)) if (/^(get|post|put|patch|delete|head|options)$/.test(verb)) out.add(`${verb.toUpperCase()} ${normalize(p)}`);
  return out;
}

export const normalize = (p: string): string => p.replace(/:([A-Za-z_]\w*)/g, '{$1}').replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
