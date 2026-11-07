// The NativeHost backed by the wisp-native binary: one long-lived helper per host, driven over
// stdio (native/PROTOCOL.md). Its stdin is its leash: if this process dies, the pipe closes and
// the helper kills every tree it started.

import { type ChildProcess, spawn } from 'node:child_process';
import { BinaryPty, BinaryTree, type Tracked, type Wire } from './binary-procs.ts';
import { NativeError } from './errors.ts';
import { PROTOCOL, type Event, type ListItem, type Request, encode, parseEvent } from './protocol.ts';
import { resolveCommand } from './resolve-command.ts';
import { DEFAULT_COLS, DEFAULT_ROWS, GONE_KEPT, clampSize, graceOf } from './running.ts';
import type { BinarySource, HostInfo, KillOptions, KillReport, NativeHost, Pty, SpawnOptions, SpawnPtyOptions, TreeProcess } from './types.ts';

export interface BinaryStart {
  binary: string;
  source: BinarySource;
  /** a line the helper logged on stderr, or a line it sent that isn't an event */
  log?: (line: string) => void;
  helloTimeoutMs?: number;
}

type Waiter<T> = { resolve: (v: T) => void; reject: (e: NativeError) => void };
/** A spawn waiting for `started`: makes the process object and hands it to the caller. */
type Spawning = { start: (pid: number) => Tracked; reject: (e: NativeError) => void };

export async function startBinary(opts: BinaryStart): Promise<NativeHost> {
  const child = spawn(opts.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const host = new BinaryHost(child, opts);
  await host.ready(opts.helloTimeoutMs ?? 5000);
  return host;
}

class BinaryHost implements NativeHost, Wire {
  info: HostInfo;
  readonly #child: ChildProcess;
  readonly #log: (line: string) => void;
  readonly #live = new Map<string, Tracked>();
  readonly #gone = new Map<string, Tracked>();
  readonly #spawning = new Map<string, Spawning>();
  readonly #refs = new Map<string, Waiter<Event>>();
  readonly #hello: Promise<Extract<Event, { type: 'hello' }>>;
  #seq = 0;
  #dead: NativeError | null = null;
  #onHello: Waiter<Extract<Event, { type: 'hello' }>> | null = null;

  constructor(child: ChildProcess, opts: BinaryStart) {
    this.#child = child;
    this.#log = opts.log ?? (() => {});
    this.info = { kind: 'native', binary: opts.binary, source: opts.source };
    this.#hello = new Promise((resolve, reject) => (this.#onHello = { resolve, reject }));
    this.#hello.catch(() => {}); // observed by ready(); a crash before anyone awaits it is not unhandled
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        this.#line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => s.split('\n').filter(Boolean).forEach((l) => this.#log(l)));
    child.stdin?.on('error', () => {}); // EPIPE once the helper is gone; 'exit' reports it
    child.on('error', (e) => this.#die(new NativeError('io', `wisp-native: ${e.message}`, true)));
    child.on('exit', (code, signal) => this.#die(new NativeError('io', `wisp-native exited (${signal ?? code})`, true)));
  }

  async ready(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NativeError('io', `wisp-native sent no hello in ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const hello = await Promise.race([this.#hello, late]);
      if (hello.protocol !== PROTOCOL) throw new NativeError('unsupported', `wisp-native speaks protocol ${hello.protocol}, this server ${PROTOCOL}`);
      this.info = { ...this.info, version: hello.version };
    } catch (e) {
      this.#child.kill('SIGKILL');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  send(req: Request): void {
    if (this.#dead) throw this.#dead;
    this.#child.stdin?.write(encode(req));
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}${this.#seq}`;
  }

  #spawn<T extends Tracked>(req: Omit<Extract<Request, { type: 'spawn' }>, 'id' | 'type'>, make: (id: string, pid: number) => T): Promise<T> {
    const id = this.#id('p');
    return new Promise<T>((resolve, reject) => {
      if (this.#dead) return reject(this.#dead);
      const start = (pid: number): T => {
        const t = make(id, pid);
        resolve(t);
        return t;
      };
      this.#spawning.set(id, { start, reject });
      this.send({ type: 'spawn', id, ...req });
    });
  }

  spawnPty(opts: SpawnPtyOptions): Promise<Pty> {
    const pty = { cols: clampSize(opts.cols, DEFAULT_COLS), rows: clampSize(opts.rows, DEFAULT_ROWS) };
    return this.#spawn<BinaryPty>({ cmd: opts.cmd, ...common(opts), pty }, (id, pid) => new BinaryPty(this, id, pid));
  }

  spawnTree(opts: SpawnOptions): Promise<TreeProcess> {
    const r = resolveCommand(opts.cmd, opts.args ?? [], opts.env ? { env: opts.env } : {});
    const req = { ...common(opts), cmd: r.command, args: r.args, ...(r.verbatim ? { verbatim: true } : {}) };
    return this.#spawn<BinaryTree>(req, (id, pid) => new BinaryTree(this, id, pid));
  }

  kill(id: string, opts: KillOptions | undefined): Promise<KillReport> {
    const ref = this.#id('k');
    const req: Request = { type: 'kill', id, tree: true, ref, graceMs: graceOf(opts?.graceMs), ...(opts?.signal ? { signal: opts.signal } : {}) };
    return this.#ask(ref, req).then((e) => (e.type === 'killed' ? { signalled: e.signalled, survivors: e.survivors } : { signalled: 0, survivors: 0 }));
  }

  killTree(pid: number, opts?: KillOptions): Promise<KillReport> {
    const known = [...this.#live.values(), ...this.#gone.values()].find((t) => t.pid === pid);
    if (!known) return Promise.reject(new NativeError('unknown_id', `no process ${pid} was started here`));
    return this.kill(known.id, opts);
  }

  async list(): Promise<ListItem[]> {
    const ref = this.#id('l');
    const e = await this.#ask(ref, { type: 'list', ref });
    return e.type === 'list' ? e.items : [];
  }

  #ask(ref: string, req: Request): Promise<Event> {
    return new Promise((resolve, reject) => {
      if (this.#dead) return reject(this.#dead);
      this.#refs.set(ref, { resolve, reject });
      this.send(req);
    });
  }

  async close(): Promise<void> {
    if (this.#dead) return;
    const exited = new Promise<void>((resolve) => this.#child.once('exit', () => resolve()));
    this.#child.stdin?.end();
    // The helper gives programs a moment to go, then kills them; this waits that long and more.
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }

  #line(line: string): void {
    const e = parseEvent(line);
    if (!e) return this.#log(`unreadable: ${line.slice(0, 200)}`);
    this.#event(e);
  }

  #event(e: Event): void {
    switch (e.type) {
      case 'hello':
        return this.#onHello?.resolve(e);
      case 'started': {
        const w = this.#spawning.get(e.id);
        if (!w) return;
        this.#spawning.delete(e.id);
        this.#live.set(e.id, w.start(e.pid));
        return;
      }
      case 'data':
        return this.#live.get(e.id)?.data(e.stream, Buffer.from(e.data, 'base64'));
      case 'exit':
        return this.#exited(e.id, { code: e.code, signal: e.signal });
      case 'killed':
      case 'list':
        return this.#answer(e.ref, e);
      case 'error':
        return this.#error(e);
    }
  }

  #exited(id: string, info: { code: number | null; signal: string | null }): void {
    const t = this.#live.get(id);
    if (!t) return;
    this.#live.delete(id);
    this.#gone.set(id, t);
    if (this.#gone.size > GONE_KEPT) this.#gone.delete(this.#gone.keys().next().value ?? '');
    t.finish(info);
  }

  #answer(ref: string | undefined, e: Event): void {
    const w = ref ? this.#refs.get(ref) : undefined;
    if (!w || !ref) return;
    this.#refs.delete(ref);
    w.resolve(e);
  }

  #error(e: Extract<Event, { type: 'error' }>): void {
    const err = new NativeError(e.code, e.message, e.retry);
    const spawning = e.id ? this.#spawning.get(e.id) : undefined;
    if (e.id && spawning) {
      this.#spawning.delete(e.id);
      return spawning.reject(err);
    }
    const w = e.ref ? this.#refs.get(e.ref) : undefined;
    if (e.ref && w) {
      this.#refs.delete(e.ref);
      return w.reject(err);
    }
    // Typing into a terminal that just exited, and the like: nobody is waiting on these.
    this.#log(`${e.code}: ${e.message}`);
  }

  #die(err: NativeError): void {
    if (this.#dead) return;
    this.#dead = err;
    this.#onHello?.reject(err);
    for (const w of [...this.#spawning.values(), ...this.#refs.values()]) w.reject(err);
    this.#spawning.clear();
    this.#refs.clear();
    for (const t of this.#live.values()) {
      // The helper died without its sweep (it was killed): end its trees from here. Each leads
      // its own process group, so its pid is the group id.
      if (process.platform !== 'win32') {
        try {
          process.kill(-t.pid, 'SIGKILL');
        } catch {}
      }
      t.finish({ code: null, signal: null });
    }
    this.#live.clear();
  }
}

function common(opts: SpawnOptions): { args: string[]; cwd?: string; env?: Readonly<Record<string, string>> } {
  return { args: [...(opts.args ?? [])], ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}) };
}
