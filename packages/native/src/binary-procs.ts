// The Pty and TreeProcess objects of the binary backend: thin views over protocol messages.

import { Readable, Writable } from 'node:stream';
import type { Request, Signal } from './protocol.ts';
import { DataFeed, ExitLatch, clampSize } from './running.ts';
import type { ExitInfo, KillOptions, KillReport, Pty, TreeProcess } from './types.ts';

/** What a process object needs from its host. */
export interface Wire {
  send(req: Request): void;
  kill(id: string, opts: KillOptions | undefined): Promise<KillReport>;
}

/** One child the helper runs, as the host tracks it. */
export interface Tracked {
  readonly id: string;
  readonly pid: number;
  readonly latch: ExitLatch;
  data(stream: 'stdout' | 'stderr', chunk: Buffer): void;
  finish(e: ExitInfo): void;
}

const b64 = (data: string | Uint8Array): string => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64');

export class BinaryPty implements Pty, Tracked {
  readonly resizable = true;
  readonly latch = new ExitLatch();
  readonly exited = this.latch.exited;
  readonly #feed = new DataFeed();
  readonly #wire: Wire;
  readonly id: string;
  readonly pid: number;

  constructor(wire: Wire, id: string, pid: number) {
    this.#wire = wire;
    this.id = id;
    this.pid = pid;
  }

  data(_stream: 'stdout' | 'stderr', chunk: Buffer): void {
    this.#feed.push(chunk);
  }

  finish(e: ExitInfo): void {
    this.latch.finish(e);
  }

  onData(fn: (chunk: Buffer) => void): () => void {
    return this.#feed.on(fn);
  }

  onExit(fn: (e: ExitInfo) => void): () => void {
    return this.latch.onExit(fn);
  }

  write(data: string | Uint8Array): void {
    if (!this.latch.done) this.#wire.send({ type: 'data', id: this.id, data: b64(data) });
  }

  resize(cols: number, rows: number): boolean {
    if (this.latch.done) return false;
    this.#wire.send({ type: 'resize', id: this.id, cols: clampSize(cols, 1), rows: clampSize(rows, 1) });
    return true;
  }

  signal(sig: Signal, opts?: { tree?: boolean }): void {
    this.#wire.send({ type: 'signal', id: this.id, signal: sig, tree: opts?.tree ?? false });
  }

  kill(opts?: KillOptions): Promise<KillReport> {
    return this.#wire.kill(this.id, opts);
  }
}

export class BinaryTree implements TreeProcess, Tracked {
  readonly latch = new ExitLatch();
  readonly exited = this.latch.exited;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly stdin: Writable;
  readonly #wire: Wire;
  readonly id: string;
  readonly pid: number;

  constructor(wire: Wire, id: string, pid: number) {
    this.#wire = wire;
    this.id = id;
    this.pid = pid;
    const gone = (): boolean => this.latch.done;
    this.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!gone()) wire.send({ type: 'data', id, data: b64(chunk) });
        cb();
      },
      final(cb) {
        if (!gone()) wire.send({ type: 'eof', id });
        cb();
      },
    });
  }

  data(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    (stream === 'stdout' ? this.stdout : this.stderr).push(chunk);
  }

  finish(e: ExitInfo): void {
    if (this.latch.done) return;
    this.stdout.push(null);
    this.stderr.push(null);
    this.latch.finish(e);
  }

  onExit(fn: (e: ExitInfo) => void): () => void {
    return this.latch.onExit(fn);
  }

  signal(sig: Signal, opts?: { tree?: boolean }): void {
    this.#wire.send({ type: 'signal', id: this.id, signal: sig, tree: opts?.tree ?? false });
  }

  kill(opts?: KillOptions): Promise<KillReport> {
    return this.#wire.kill(this.id, opts);
  }
}
