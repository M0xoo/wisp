// One running language server (v1 server/lsp.js Client): LSP's JSON-RPC with Content-Length frames
// over the child's stdio. Requests by id, diagnostics by uri; the server's own requests
// (workspace/configuration …) get an answer so it carries on.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Diagnostic } from '@wisp-plugin/lsp-api';

export const IDLE_MS = 10 * 60_000; // a server nobody asked for this long goes
export const TIMEOUT_MS = 15_000;
export const DIAG_WAIT_MS = 4000;

const LANG_ID: Readonly<Record<string, string>> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript', py: 'python', pyi: 'python', go: 'go', rs: 'rust' };

/** The slice of a proc Child a client needs. */
export interface StdioChild {
  onStdout(fn: (chunk: Uint8Array) => void): unknown;
  write(data: string | Uint8Array): void;
  kill(signal?: string): void;
  readonly exited: Promise<unknown>;
}

export type Later = (ms: number, fn: () => void) => () => void;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

type Msg = { id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class LspClient {
  readonly root: string;
  readonly name: string;
  readonly ready: Promise<void>;
  dead: Error | null = null;
  #seq = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #open = new Map<string, number>(); // uri -> version
  readonly #diags = new Map<string, Diagnostic[]>();
  readonly #waiters = new Map<string, (() => void)[]>();
  #buf: Buffer = Buffer.alloc(0);
  #idle: () => void = () => {};
  readonly #child: StdioChild;
  readonly #later: Later;
  readonly #gone: () => void;

  /** gone: it stopped or died, the pool forgets it */
  constructor(child: StdioChild, root: string, name: string, o: { later: Later; pid: number; gone: () => void }) {
    this.#child = child;
    this.root = root;
    this.name = name;
    this.#later = o.later;
    this.#gone = o.gone;
    child.onStdout((d) => this.#read(d));
    child.exited.then(() => this.#die(new Error(`The ${name} language server stopped`)), (e: unknown) => this.#die(e instanceof Error ? e : new Error(String(e))));
    this.touch();
    const uri = pathToFileURL(root).href;
    this.ready = this.request('initialize', {
      processId: o.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: path.basename(root) }],
      capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } }, hover: { contentFormat: ['markdown', 'plaintext'] }, definition: {}, references: {}, publishDiagnostics: {}, synchronization: { didSave: true } } },
    }).then(() => this.notify('initialized', {}));
    this.ready.catch(() => {}); // a server that dies at once is reported by the ask that waited on it
  }

  touch(): void {
    this.#idle();
    this.#idle = this.#later(IDLE_MS, () => this.stop());
  }

  #send(msg: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    this.#child.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const cancel = this.#later(TIMEOUT_MS, () => (this.#pending.delete(id), reject(new Error(`The language server didn’t answer ${method} in time`))));
      this.#pending.set(id, { resolve: (v) => (cancel(), resolve(v)), reject: (e) => (cancel(), reject(e)) });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send({ method, ...(params !== undefined && { params }) });
  }

  #read(d: Uint8Array): void {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : Buffer.from(d);
    for (;;) {
      const head = this.#buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const len = Number(/Content-Length: *(\d+)/i.exec(this.#buf.subarray(0, head).toString())?.[1]);
      if (!(len >= 0) || this.#buf.length < head + 4 + len) return;
      let msg: unknown;
      try {
        msg = JSON.parse(this.#buf.subarray(head + 4, head + 4 + len).toString());
      } catch {
        msg = null; // a frame that isn't JSON is skipped, the next one still parses
      }
      this.#buf = this.#buf.subarray(head + 4 + len);
      if (isRecord(msg)) this.#handle(msg as Msg);
    }
  }

  #handle(msg: Msg): void {
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id !== null && !msg.method && this.#pending.has(id)) {
      const p = this.#pending.get(id);
      this.#pending.delete(id);
      if (msg.error) p?.reject(new Error(msg.error.message || 'The language server refused'));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      const items = Array.isArray(msg.params?.['items']) ? msg.params['items'] : [];
      return this.#send({ id: msg.id, result: msg.method === 'workspace/configuration' ? items.map(() => null) : null });
    }
    if (msg.method === 'textDocument/publishDiagnostics') this.#diagnosed(msg.params ?? {});
  }

  #diagnosed(p: Record<string, unknown>): void {
    const uri = String(p['uri'] ?? '');
    const list = Array.isArray(p['diagnostics']) ? p['diagnostics'].filter(isRecord) : [];
    this.#diags.set(uri, list.map((x) => {
      const start = isRecord(x['range']) && isRecord(x['range']['start']) ? x['range']['start'] : {};
      const sev = x['severity'];
      return { line: Number(start['line'] ?? 0) + 1, col: Number(start['character'] ?? 0) + 1, severity: sev === 1 ? 'error' : sev === 2 ? 'warning' : 'info', message: String(x['message'] ?? '').slice(0, 500) };
    }));
    for (const w of this.#waiters.get(uri) ?? []) w();
    this.#waiters.delete(uri);
  }

  /** The editor's copy of a file (unsaved edits too) is what the server reads. */
  sync(file: string, text: string): string {
    const uri = pathToFileURL(file).href;
    const v = (this.#open.get(uri) ?? 0) + 1;
    if (v === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANG_ID[path.extname(file).slice(1).toLowerCase()] ?? 'plaintext', version: v, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text }] });
    this.#open.set(uri, v);
    return uri;
  }

  diagnostics(uri: string, wait = DIAG_WAIT_MS): Promise<Diagnostic[]> {
    const have = this.#diags.get(uri);
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => {
      let cancel = (): void => {};
      const done = (): void => (cancel(), resolve(this.#diags.get(uri) ?? []));
      this.#waiters.set(uri, [...(this.#waiters.get(uri) ?? []), done]);
      cancel = this.#later(wait, done);
    });
  }

  #die(err: Error): void {
    if (!this.dead) this.dead = err;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#idle();
    this.#gone();
  }

  stop(): void {
    if (this.dead) return;
    this.dead = new Error('stopped');
    try {
      this.#send({ id: ++this.#seq, method: 'shutdown' });
      this.notify('exit');
    } catch {
      // the pipe is already gone: the kill below is all that's left
    }
    this.#idle();
    this.#later(500, () => this.#child.kill());
    this.#gone();
  }
}
