// Boot (v1 server/index.js startServer): open the store, make the kernel with its services, register
// the edge's plugin and a plugin group, mount the HTTP edge and sync, listen, and advertise the server in
// $WISP_HOME/server.json so the CLI, MCP and editors find it without knowing the port.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CapabilityRegistry, glob, Kernel, type HttpService, type Json, type Log, type PluginGroup, type ProcService } from '@wisp/kernel';
import { openStore, type Store } from '@wisp/store';
import { EdgePoints, pathMatches, SERVER_MANIFEST } from './server-points.ts';
import { handle, type EdgeOptions } from './http/edge.ts';
import { send } from './http/respond.ts';
import { previewPort, previewUpgrade } from './http/preview.ts';
import { Routes } from './http/router.ts';
import { StaticFiles } from './http/static.ts';
import { trustedProxy } from './http/trust.ts';
import { API_VERSION, DEFAULT_PORT, VERSION } from './meta.ts';
import { openapiDoc } from './openapi.ts';
import { registerMeta } from './routes.ts';
import { fanoutNotify, homePaths, timedNet } from './services/basic.ts';
import { basicProc } from './services/proc-basic.ts';
import { fileSecrets } from './services/secrets.ts';
import { storeSettings } from './services/settings.ts';
import { SyncEdge } from './sync.ts';

// Idle keep-alive connections are closed by the client first (Node's fetch: 4 s): with Node's 5 s
// default the two raced, and a request sent on a socket the server was closing got ECONNRESET.
const KEEP_ALIVE_MS = 65_000;

export interface ServerOptions {
  port?: number;
  host?: string;
  /** $WISP_HOME, else ~/.wisp */
  home?: string;
  handleSignals?: boolean;
  /** the plugins to run; the CLI picks DefaultPlugins (or BoxPlugins on a grid box) */
  group?: PluginGroup | ((home: string) => PluginGroup);
  /** the built web app; null serves the API only */
  web?: string | null;
  /** replace kernel services (the grid's proc, a test's net) */
  services?: { proc?: ProcService; net?: unknown };
  log?: Log;
  /** answer openapi parts of the plugins (lazy: imported on the first /api/openapi.json) */
  openapiParts?: () => Promise<readonly unknown[]>;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  home: string;
  store: Store;
  kernel: Kernel;
  routes: Routes;
  /** ms from startServer() to listening */
  bootMs: number;
  close(): Promise<void>;
}

const consoleLog: Log = {
  debug: () => undefined,
  info: (m, d) => console.log(`wisp: ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`wisp: ${m}`, d ?? ''),
  error: (m, d) => console.error(`wisp: ${m}`, d ?? ''),
};

export const defaultHome = (): string => process.env['WISP_HOME'] ?? path.join(os.homedir(), '.wisp');

/** The web build beside the bundle (dist/web), else apps/web/dist in the repo. */
function webDir(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return process.env['WISP_WEB_DIR'] ?? (path.basename(here) === 'dist' ? path.join(here, 'web') : path.resolve(here, '..', '..', 'web', 'dist'));
}

function httpService(routes: Routes, url: () => string): HttpService {
  return {
    route: (method, pattern, handler, opts) => routes.add('plugin', method, pattern, handler, opts),
    raw: (method, pattern, handler, opts) => routes.add('plugin', method, pattern, handler, opts, true),
    get url() {
      return url();
    },
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const t0 = performance.now();
  const home = opts.home ?? defaultHome();
  mkdirSync(home, { recursive: true }); // boot: before anything reads or writes there
  const log = opts.log ?? consoleLog;
  const store = openStore({ path: path.join(home, 'wisp.db') });
  const token = randomBytes(16).toString('hex');
  let port = opts.port ?? DEFAULT_PORT;
  const url = (): string => `http://127.0.0.1:${port}`;
  const routes = new Routes();
  const proxy = trustedProxy();
  const points = new EdgePoints();
  const capabilities = new CapabilityRegistry();
  capabilities.define({ id: 'connector', allow: ['connectors:token'] });
  let sync: SyncEdge | undefined;
  const notify = fanoutNotify([(kind, data) => sync?.notice(kind, data)]);
  const kernel = new Kernel({
    log,
    capabilities,
    settings: storeSettings(store, home),
    services: { store, blob: store.blobs, http: httpService(routes, url), secrets: fileSecrets(home), notify, net: opts.services?.net ?? timedNet(), paths: homePaths(home), proc: opts.services?.proc ?? basicProc() },
  });
  kernel.register(SERVER_MANIFEST, { def: points.def, builtin: true });
  if (opts.group) kernel.addGroup(typeof opts.group === 'function' ? opts.group(home) : opts.group);
  sync = new SyncEdge({
    store,
    peer: () => ({ peer: store.epoch, name: os.hostname(), build: VERSION, version: VERSION, proto_min: 2, proto_max: 2, plugins: [] }),
    canRead: (c, topic) => kernel.checkCaller(c, `topic:read{topic:${topic}}`) === undefined,
    run: (cmd, args, caller) => kernel.dispatchRun({ cmd, args, caller }),
    topics: points.topics,
    legacy: points.legacy,
    glob,
  });
  const live = sync;
  const unCommit = store.onCommit((rows) => live.committed(rows));
  let lastActivityAt = Date.now();
  // the plugins' parts load their host modules: only when someone asks for the document
  let openapiCache: Promise<Json> | undefined;
  const openapi = (): Promise<Json> =>
    (openapiCache ??= (opts.openapiParts?.() ?? Promise.resolve([])).then((parts) => openapiDoc({ version: VERSION, port, parts }), () => openapiDoc({ version: VERSION, port, parts: [] })));
  registerMeta({
    routes,
    sync: live,
    status: points.status,
    lastActivityAt: () => lastActivityAt,
    publicUrl: () => proxy.origin ?? url(),
    openapi,
  });
  await kernel.start();

  const web = opts.web === null ? null : new StaticFiles({ dir: opts.web ?? webDir() });
  const previews = proxy.on && !!process.env['WISP_PREVIEW_URL'];
  const edge: EdgeOptions = {
    port: () => port,
    routes,
    static: web,
    proxy,
    auth: { master: token, userSet: process.env['WISP_GRID_URL'] ? 'box' : 'user:full', setFor: (s) => points.setFor(s) },
    check: (caller, permission) => kernel.checkCaller(caller, permission),
    open: (method, p) => points.open().some((o) => o.method === method && pathMatches(o.path, p)),
    // a channel's inbound message must never keep a cloud wisp awake: the work it starts does that
    touched: (method, p) => {
      if (!points.quiet().some((q) => q.method === method && pathMatches(q.path, p))) lastActivityAt = Date.now();
    },
    previews,
    onError: (err, route) => log.error(`${route}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
  };
  const server = http.createServer((req, res) => {
    handle(req, res, edge).catch((err: unknown) => {
      edge.onError(err, `${req.method ?? ''} ${req.url ?? ''}`);
      if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err), code: 'internal' });
    });
  });
  server.on('upgrade', (req, socket, head: Buffer) => {
    const p = previews && proxy.via(req) ? previewPort(req.headers, port) : 0;
    if (!p) socket.destroy();
    else previewUpgrade(req, socket, head, p);
  });
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const bootMs = performance.now() - t0;
  const serverFile = path.join(home, 'server.json');
  writeFileSync(serverFile, JSON.stringify({ url: url(), port, pid: process.pid, version: VERSION, apiVersion: API_VERSION, startedAt: Date.now() }, null, 2));
  // the page's files, read and compressed before the window asks (after the first response can go)
  if (web) setImmediate(() => void web.warm());

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closed ??= (async () => {
      try {
        if ((JSON.parse(readFileSync(serverFile, 'utf8')) as { pid?: number }).pid === process.pid) rmSync(serverFile, { force: true });
      } catch {
        // already gone, or another wisp's now
      }
      kernel.stop();
      unCommit.dispose();
      live.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    })());
  if (opts.handleSignals) {
    const exit = (): void => void close().finally(() => process.exit(0));
    process.once('SIGINT', exit);
    process.once('SIGTERM', exit);
  }
  return { url: `http://localhost:${port}`, port, token, home, store, kernel, routes, bootMs, close };
}
