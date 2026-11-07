// One connector as the stdio MCP server a harness starts (v1 server/mcp-connector.js), as a function:
// lines in, lines out. A local one runs its command with its secrets in the env; a remote one is
// bridged, each JSON-RPC line a Streamable HTTP POST (or the older SSE transport for a URL ending in
// /sse), and what comes back, JSON or an event stream, goes out as lines.
//
// wisp runs it in-process to test a connector (probe.ts); the edge's bin runs it for a harness
// (`wisp connector <id>`), with process stdio, after fetching the spec with its connector token.

import type { ProcService } from '@wisp/kernel';
import type { ProxySpec } from '@wisp-plugin/connectors-api';

export interface ProxyDeps {
  /** what a local connector is started with */
  proc: Pick<ProcService, 'spawn' | 'which'>;
  net: { fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> };
  /** a signed-in connector's token from wisp, the one that refreshes them; null: sign in again */
  freshToken(force: boolean): Promise<string | null>;
  /** the env a local command starts from (the bin's process.env) */
  env: Readonly<Record<string, string | undefined>>;
  /** what ~ means in a command, as a shell would read it */
  home: string;
  now(): number;
  /** a line for the harness (stdout) */
  out(line: string): void;
  /** a line for the harness's log (stderr) */
  err(text: string): void;
}

export interface ProxySession {
  /** a line from the harness (stdin) */
  send(line: string): void;
  /** the harness closed stdin */
  end(): void;
  kill(): void;
  /** the exit code the bin ends with */
  readonly exited: Promise<number>;
}

const isJsonRpc = (m: unknown): m is { id?: unknown; method?: unknown } => !!m && typeof m === 'object';

export function runProxy(spec: ProxySpec, deps: ProxyDeps): ProxySession {
  return spec.connector.transport === 'local' ? runLocal(spec, deps) : runRemote(spec, deps);
}

// ---------- local: its command on this stdio ----------

const tilde = (a: string, home: string): string => String(a).replace(/^~(?=$|[\\/])/, home);
const hasPath = (s: string): boolean => /[\\/]/.test(s);

function lines(onLine: (l: string) => void): (chunk: Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = '';
  return (chunk) => {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

function runLocal(spec: ProxySpec, d: ProxyDeps): ProxySession {
  const c = spec.connector;
  const env: Record<string, string | undefined> = { ...d.env, ...spec.env };
  delete env['ELECTRON_RUN_AS_NODE']; // set by builds from before Tauri; harmless, but not the server's
  delete env['WISP_HOME'];
  const queue: string[] = [];
  let ended = false;
  let kill = (): void => {};
  let write = (l: string): void => void queue.push(l);
  let close = (): void => void (ended = true);
  const exited = (async (): Promise<number> => {
    const cmd = tilde(c.command ?? '', d.home);
    // npx, uvx … are .cmd shims on Windows: the proc service resolves them on PATH.
    const bin = hasPath(cmd) ? cmd : await d.proc.which(cmd, env);
    if (!bin) {
      d.err(`wisp: couldn’t start ${c.command}: not found on PATH`);
      return 127;
    }
    let child;
    try {
      child = d.proc.spawn(bin, (c.args || []).map((a) => tilde(a, d.home)), { env, stdin: 'pipe' });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      d.err(`wisp: couldn’t start ${c.command}: ${err.code === 'ENOENT' ? 'not found on PATH' : String(err.message)}`);
      return 127;
    }
    child.onStdout(lines(d.out));
    child.onStderr((b) => d.err(new TextDecoder().decode(b).replace(/\n$/, '')));
    kill = () => child.kill('SIGTERM');
    write = (l) => child.write(`${l}\n`);
    close = () => child.closeStdin();
    for (const l of queue.splice(0)) write(l);
    if (ended) close();
    try {
      const r = await child.exited;
      return r.code ?? (r.signal ? 1 : 0);
    } catch (e) {
      d.err(`wisp: couldn’t start ${c.command}: ${(e as { code?: string }).code === 'ENOENT' ? 'not found on PATH' : (e as Error).message}`);
      return 127;
    }
  })();
  return { send: (l) => write(l), end: () => close(), kill: () => kill(), exited };
}

// ---------- remote: bridged over HTTP ----------

/** SSE: "data:" lines up to a blank line make one event. */
async function events(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ev: { event: string; data: string[] } = { event: 'message', data: [] };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
      if (!line) {
        if (ev.data.length) onEvent(ev.event, ev.data.join('\n'));
        ev = { event: 'message', data: [] };
      } else if (line.startsWith('data:')) ev.data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
    }
  }
}

class Remote {
  readonly #spec: ProxySpec;
  readonly #d: ProxyDeps;
  readonly #name: string;
  readonly #url: string;
  #auth: Promise<string | null> | null;
  #session = '';
  #version = '';
  #started: Promise<void> = Promise.resolve();
  readonly #legacy: { endpoint: Promise<string> } | null;
  readonly #done: { resolve: (code: number) => void; promise: Promise<number> };

  constructor(spec: ProxySpec, d: ProxyDeps) {
    this.#spec = spec;
    this.#d = d;
    const c = spec.connector;
    this.#name = c.name;
    this.#url = c.url ?? '';
    // Signed in: its token, refreshed first if it's about to run out.
    this.#auth = c.oauth ? (c.oauth.expiresAt && c.oauth.expiresAt < d.now() + 60_000 ? d.freshToken(false) : spec.access ? Promise.resolve(spec.access) : d.freshToken(false)) : null;
    let resolve: (code: number) => void = () => {};
    const promise = new Promise<number>((r) => (resolve = r));
    this.#done = { resolve, promise };
    this.#legacy = /\/sse\/?$/.test(new URL(this.#url).pathname) ? this.#openLegacy() : null;
  }

  get exited(): Promise<number> {
    return this.#done.promise;
  }

  #out(msg: unknown): void {
    this.#d.out(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  // A request that failed still needs an answer, or the harness waits for it until its timeout.
  #fail(msg: { id?: unknown; method?: unknown }, text: string): void {
    if (msg.id != null && msg.method) this.#out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `${this.#name}: ${text}` } });
    else this.#d.err(`wisp: ${this.#name}: ${text}`);
  }

  async #authorized(): Promise<Record<string, string>> {
    return this.#auth ? { ...this.#spec.headers, authorization: `Bearer ${(await this.#auth) || ''}` } : { ...this.#spec.headers };
  }

  // The 2024 transport: a GET stream that names an endpoint to POST to, and carries the replies.
  #openLegacy(): { endpoint: Promise<string> } {
    let ready: (u: string) => void = () => {};
    const endpoint = new Promise<string>((r) => (ready = r));
    void this.#authorized()
      .then((h) => this.#d.net.fetch(this.#url, { headers: { ...h, accept: 'text/event-stream' } }))
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        await events(res.body, (event, data) => (event === 'endpoint' ? ready(new URL(data, this.#url).href) : this.#out(data)));
      })
      .then(
        () => this.#done.resolve(0),
        (e: unknown) => {
          this.#d.err(`wisp: ${this.#name}: ${(e as Error).message}`);
          this.#done.resolve(1);
        },
      );
    return { endpoint };
  }

  // Replies go out as they are; initialize's says which protocol version later requests carry.
  #deliver(msg: { method?: unknown }, text: string): void {
    if (msg.method === 'initialize') {
      try {
        const body: unknown = JSON.parse(text);
        const hit = [body].flat().find((m) => (m as { result?: { protocolVersion?: unknown } })?.result?.protocolVersion) as { result: { protocolVersion: string } } | undefined;
        this.#version = hit?.result.protocolVersion || this.#version;
      } catch {
        // not JSON: passed on as it is
      }
    }
    if (text.startsWith('[')) for (const m of JSON.parse(text) as unknown[]) this.#out(m);
    else this.#out(text);
  }

  async post(msg: { id?: unknown; method?: unknown }, retried = false): Promise<void> {
    try {
      const headers = await this.#authorized();
      if (this.#legacy) {
        const res = await this.#d.net.fetch(await this.#legacy.endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(msg) });
        if (!res.ok) this.#fail(msg, `HTTP ${res.status}`);
        return;
      }
      const res = await this.#d.net.fetch(this.#url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.#session && { 'mcp-session-id': this.#session }), ...(this.#version && { 'mcp-protocol-version': this.#version }) },
        body: JSON.stringify(msg),
      });
      this.#session = res.headers.get('mcp-session-id') || this.#session;
      if (res.status === 401 || res.status === 403) return await this.#refused(res, msg, retried);
      if (!res.ok) return this.#fail(msg, `HTTP ${res.status} ${res.statusText}`.trim());
      if (res.status === 202 || !res.body) return;
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        await events(res.body, (event, data) => event === 'message' && this.#deliver(msg, data));
      } else {
        const text = (await res.text()).trim();
        if (text) this.#deliver(msg, text);
      }
    } catch (e) {
      const err = e as { message?: string; cause?: { code?: string } };
      this.#fail(msg, err.cause?.code === 'ENOTFOUND' ? `can’t find ${new URL(this.#url).host}` : String(err.message));
    }
  }

  async #refused(res: Response, msg: { id?: unknown; method?: unknown }, retried: boolean): Promise<void> {
    await res.body?.cancel().catch(() => {});
    // A token that ran out early: one fresh one, then the request again.
    if (this.#auth && !retried) {
      this.#auth = this.#d.freshToken(true);
      if (await this.#auth) return this.post(msg, true);
    }
    this.#fail(msg, `needs sign-in (HTTP ${res.status}). ${this.#spec.connector.oauth ? 'Sign in again' : 'Sign in, or check its headers,'} in Settings → Connectors`);
  }

  send(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isJsonRpc(msg)) return;
    // Everything after initialize waits for its reply: that's where the session id comes from.
    if (msg.method === 'initialize') this.#started = this.post(msg);
    else void this.#started.then(() => this.post(msg));
  }

  end(): void {
    // Let the server forget the session; don't wait long for it.
    if (this.#session && !this.#legacy) {
      void this.#d.net
        .fetch(this.#url, { method: 'DELETE', headers: { ...this.#spec.headers, 'mcp-session-id': this.#session }, timeoutMs: 2000 })
        .catch(() => undefined)
        .finally(() => this.#done.resolve(0));
    } else this.#done.resolve(0);
  }
}

function runRemote(spec: ProxySpec, d: ProxyDeps): ProxySession {
  const r = new Remote(spec, d);
  return { send: (l) => r.send(l), end: () => r.end(), kill: () => r.end(), exited: r.exited };
}
