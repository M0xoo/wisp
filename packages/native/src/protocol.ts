// The wisp-native wire (native/PROTOCOL.md): one JSON object per line. Requests go to the helper's
// stdin, events come from its stdout. Mirrors native/crates/wisp-native/src/protocol.rs; a change
// to either side changes both, and PROTOCOL.md.

/** Bumped only for a change an older peer would misread; additions don't bump it. */
export const PROTOCOL = 1;

export const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGALRM', 'SIGPIPE'] as const;
export type Signal = (typeof SIGNALS)[number];

export interface SpawnRequest {
  type: 'spawn';
  id: string;
  cmd: string;
  args?: readonly string[];
  cwd?: string;
  /** The complete environment; absent means "inherit the helper's". */
  env?: Readonly<Record<string, string>>;
  pty?: { cols: number; rows: number };
  /** Windows only: args are already quoted for cmd.exe; pass them as written. */
  verbatim?: boolean;
}

export type Request =
  | SpawnRequest
  | { type: 'data'; id: string; data: string }
  | { type: 'eof'; id: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'signal'; id: string; signal: Signal; tree?: boolean }
  | { type: 'kill'; id: string; tree?: boolean; signal?: Signal; graceMs?: number; ref?: string }
  | { type: 'list'; ref?: string };

export type ErrorCode = 'bad_request' | 'unknown_id' | 'duplicate_id' | 'spawn_failed' | 'exited' | 'unsupported' | 'io';

export interface ListItem {
  id: string;
  pid: number;
  pty: boolean;
  exited: boolean;
}

export type Event =
  | { type: 'hello'; protocol: number; version: string; pid: number; platform: string; arch: string }
  | { type: 'started'; id: string; pid: number }
  | { type: 'data'; id: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; id: string; code: number | null; signal: string | null }
  | { type: 'killed'; id: string; ref?: string; signalled: number; survivors: number }
  | { type: 'list'; ref?: string; items: ListItem[] }
  | { type: 'error'; id?: string; ref?: string; code: ErrorCode; message: string; retry: boolean };

export const encode = (req: Request): string => `${JSON.stringify(req)}\n`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): boolean => typeof o[k] === 'string';
const num = (o: Obj, k: string): boolean => typeof o[k] === 'number' && Number.isFinite(o[k]);
const optStr = (o: Obj, k: string): boolean => o[k] === undefined || str(o, k);
const strOrNull = (o: Obj, k: string): boolean => o[k] === null || str(o, k);
const numOrNull = (o: Obj, k: string): boolean => o[k] === null || num(o, k);
const CODES: ReadonlySet<string> = new Set<ErrorCode>(['bad_request', 'unknown_id', 'duplicate_id', 'spawn_failed', 'exited', 'unsupported', 'io']);

const SHAPES: Record<Event['type'], (o: Obj) => boolean> = {
  hello: (o) => num(o, 'protocol') && str(o, 'version') && num(o, 'pid') && str(o, 'platform') && str(o, 'arch'),
  started: (o) => str(o, 'id') && num(o, 'pid'),
  data: (o) => str(o, 'id') && (o['stream'] === 'stdout' || o['stream'] === 'stderr') && str(o, 'data'),
  exit: (o) => str(o, 'id') && numOrNull(o, 'code') && strOrNull(o, 'signal'),
  killed: (o) => str(o, 'id') && optStr(o, 'ref') && num(o, 'signalled') && num(o, 'survivors'),
  list: (o) => optStr(o, 'ref') && Array.isArray(o['items']) && o['items'].every((i) => isObj(i) && str(i, 'id') && num(i, 'pid') && typeof i['pty'] === 'boolean' && typeof i['exited'] === 'boolean'),
  error: (o) => optStr(o, 'id') && optStr(o, 'ref') && typeof o['code'] === 'string' && CODES.has(o['code']) && str(o, 'message') && typeof o['retry'] === 'boolean',
};

/** One stdout line → an event, or null for anything that isn't one (it is logged, not fatal). */
export function parseEvent(line: string): Event | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v['type'] !== 'string' || !Object.hasOwn(SHAPES, v['type'])) return null;
  const shape = SHAPES[v['type'] as Event['type']];
  // The shape check above is what makes this cast true.
  return shape(v) ? (v as unknown as Event) : null;
}
