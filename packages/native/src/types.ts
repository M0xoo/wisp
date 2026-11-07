// The public API of @wisp/native. The terminal and runtime plugins program against these; both
// backends (the wisp-native binary and the fallback) implement them the same way.

import type { Readable, Writable } from 'node:stream';
import type { ListItem, Signal } from './protocol.ts';

export interface ExitInfo {
  /** null when a signal ended it */
  code: number | null;
  /** e.g. 'SIGTERM'; null when it exited by itself */
  signal: string | null;
}

export interface KillOptions {
  /** sent first (default SIGTERM); SIGKILL follows for whatever is left after graceMs */
  signal?: Signal;
  /** default 2000, at most 60000 */
  graceMs?: number;
}

export interface KillReport {
  /** processes the tree held when the kill began */
  signalled: number;
  /** processes still running afterwards: 0 is the promise (gate G12) */
  survivors: number;
}

export interface SpawnOptions {
  cmd: string;
  args?: readonly string[];
  cwd?: string;
  /** the complete environment; omitted inherits the server's */
  env?: Readonly<Record<string, string>>;
}

export interface SpawnPtyOptions extends SpawnOptions {
  cols?: number;
  rows?: number;
}

interface Running {
  readonly pid: number;
  /** resolves once, with how it ended; output delivered before it */
  readonly exited: Promise<ExitInfo>;
  /** called once; called at once if it has already exited. Returns an unsubscribe. */
  onExit(fn: (e: ExitInfo) => void): () => void;
  /** send a signal to it, or to its whole tree */
  signal(sig: Signal, opts?: { tree?: boolean }): void;
  /** end it and everything it started; also reaches what it left behind after it exited */
  kill(opts?: KillOptions): Promise<KillReport>;
}

export interface Pty extends Running {
  /** false on the script(1) fallback, which keeps the size it started with */
  readonly resizable: boolean;
  /** output; chunks that came before the first subscriber are replayed to it */
  onData(fn: (chunk: Buffer) => void): () => void;
  write(data: string | Uint8Array): void;
  /** true when the new size was applied */
  resize(cols: number, rows: number): boolean;
}

export interface TreeProcess extends Running {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface HostInfo {
  kind: 'native' | 'fallback';
  /** the binary in use, and where it was found */
  binary?: string;
  source?: BinarySource;
  version?: string;
  /** why the fallback is in use */
  reason?: string;
}

export type BinarySource = 'env' | 'package' | 'dev';

export interface NativeHost {
  readonly info: HostInfo;
  spawnPty(opts: SpawnPtyOptions): Promise<Pty>;
  spawnTree(opts: SpawnOptions): Promise<TreeProcess>;
  /** kill the tree of a process this host started (by its pid) */
  killTree(pid: number, opts?: KillOptions): Promise<KillReport>;
  list(): Promise<ListItem[]>;
  /** kill every tree this host started, then stop */
  close(): Promise<void>;
}
