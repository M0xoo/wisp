// JSON-RPC 2.0 over a pair of byte streams, one message per line (the LSP/MCP model without headers).
// Both sides use it: the kernel talks to an exec plugin's stdin/stdout, the plugin to its own.
// Errors carry the WireError in `data`, so a refusal keeps its code across the process boundary.
import type { Readable, Writable } from 'node:stream';
import { fail, KernelError, toKernelError } from '../errors.ts';

export const METHOD_NOT_FOUND = -32601;
export const PARSE_ERROR = -32700;
export const SERVER_ERROR = -32000;

export type RpcHandler = (method: string, params: unknown) => unknown;

interface Pending {
  ok: (v: unknown) => void;
  no: (e: unknown) => void;
}

interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcPeer {
  readonly #out: Writable;
  readonly #handler: RpcHandler;
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #buf = '';
  #closed: string | undefined;

  constructor(input: Readable, output: Writable, handler: RpcHandler) {
    this.#out = output;
    this.#handler = handler;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.#data(chunk));
    input.on('end', () => this.close('the other side closed the stream'));
    output.on('error', (e: Error) => this.close(`write failed: ${e.message}`));
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(fail('unavailable', `${method}: ${this.#closed}`));
    const id = this.#next++;
    return new Promise((ok, no) => {
      this.#pending.set(id, { ok, no });
      this.#send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.#closed) this.#send({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
  }

  /** Fail every pending request and stop: the process is gone or going. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const p of this.#pending.values()) p.no(fail('unavailable', reason));
    this.#pending.clear();
  }

  #send(m: Message): void {
    try {
      this.#out.write(`${JSON.stringify(m)}\n`);
    } catch (e) {
      this.close(`write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  #data(chunk: string): void {
    this.#buf += chunk;
    for (let nl = this.#buf.indexOf('\n'); nl >= 0; nl = this.#buf.indexOf('\n')) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line) this.#line(line);
    }
  }

  #line(line: string): void {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      this.#send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: `not JSON: ${line.slice(0, 80)}` } });
      return;
    }
    if (typeof m !== 'object' || m === null) return;
    const msg = m as Message;
    if (typeof msg.method === 'string') this.#call(msg);
    else if (typeof msg.id === 'number') this.#reply(msg);
  }

  // Handlers run in arrival order, synchronously up to their first await: an `emit` the child sent
  // before a command's result is applied before that result is seen.
  #call(m: Message): void {
    const id = m.id;
    const answer = id !== undefined && id !== null;
    let out: unknown;
    try {
      out = this.#handler(m.method ?? '', m.params);
    } catch (e) {
      if (answer) this.#error(id, e);
      return;
    }
    if (!answer) {
      Promise.resolve(out).catch(() => undefined);
      return;
    }
    Promise.resolve(out).then(
      (result) => this.#send({ jsonrpc: '2.0', id, result: result === undefined ? null : result }),
      (e: unknown) => this.#error(id, e),
    );
  }

  #error(id: number | string, e: unknown): void {
    const k = toKernelError(e);
    const code = k.code === 'not_found' && k.message.startsWith('no method') ? METHOD_NOT_FOUND : SERVER_ERROR;
    this.#send({ jsonrpc: '2.0', id, error: { code, message: k.message, data: k.toWire() } });
  }

  #reply(m: Message): void {
    const id = Number(m.id);
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (!m.error) return p.ok(m.result);
    const w = m.error.data as { code?: unknown; message?: unknown; retry?: unknown } | undefined;
    p.no(typeof w?.code === 'string' ? new KernelError(w.code, String(w.message ?? m.error.message), undefined, w.retry === true) : new KernelError('internal', m.error.message));
  }
}

export const noMethod = (method: string): KernelError => fail('not_found', `no method ${method}`);
