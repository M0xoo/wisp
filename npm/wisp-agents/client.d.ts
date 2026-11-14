// wisp's TypeScript SDK (ADR-0028). Every call is a command or a topic subscription. Types for each command
// come from the running wisp: write `generateTypes(await w.catalogue())` to a .d.ts in your project.

export declare const DEFAULT_PORT: number;
export declare const PROTO: number;
export declare function wispHome(): string;
/** The port the running wisp advertises in `<home>/server.json`, or null. */
export declare function discover(home?: string): number | null;

export declare class WispError extends Error {
  code: string;
  status: number;
  /** a retry may help (the server said so, or it couldn't be reached) */
  retry: boolean;
  body: unknown;
  constructor(message: string, opts?: { code?: string; status?: number; retry?: boolean; body?: unknown });
}

export interface SseEvent {
  event: string;
  id: string | null;
  data: string;
}
export declare class SseParser {
  push(text: string): SseEvent[];
}
/** A sync frame's server messages, or null for any other event. */
export declare function decodeFrame(ev: SseEvent): Array<{ t: string; [k: string]: unknown }> | null;

export interface CatalogueEntry {
  id: string;
  plugin: string;
  title?: string | null;
  readOnly: boolean;
  permission: string;
  /** the args' TypeScript type, inline */
  args?: string | null;
  uiOnly?: string | null;
}
/** A `.d.ts` typing `cmd` for every command a catalogue lists. */
export declare function generateTypes(catalogue: CatalogueEntry[]): string;

/** A task as `runtime.get` gives it (the fields scripts read most; the rest is there too). */
export interface Task {
  id: string;
  title: string;
  state: 'running' | 'review' | 'done' | string;
  agent: string;
  model: string;
  cwd: string;
  [k: string]: unknown;
}

export interface RunSpec {
  prompt: string;
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
  mode?: 'plan' | 'edits' | 'auto';
  worktree?: boolean;
  /** go past Ask near the limit's line (the user agreed) */
  confirmLimit?: boolean;
  [k: string]: unknown;
}

export declare class WispClient {
  url: string;
  token: string;
  clientId: string;
  constructor(opts?: { url?: string; token?: string });
  /** The running wisp, or one started with `wisp serve` when `start` and none answers. */
  static connect(opts?: { url?: string; port?: number; home?: string; token?: string; start?: boolean; timeoutMs?: number }): Promise<WispClient>;
  alive(): Promise<boolean>;
  /** One command: its result, or a WispError. The same `key` makes a retry one command. */
  cmd(id: string, args?: Record<string, unknown>, opts?: { key?: string; signal?: AbortSignal }): Promise<unknown>;
  catalogue(): Promise<CatalogueEntry[]>;
  run(spec: RunSpec): Promise<{ id: string; [k: string]: unknown }>;
  get(id: string): Promise<Task>;
  list(args?: Record<string, unknown>): Promise<Task[]>;
  turns(id: string, args?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  presentation(id: string, args?: { turn?: number }): Promise<{ blocks: unknown[]; [k: string]: unknown } | null>;
  followUp(id: string, text: string, opts?: { queue?: boolean; mode?: string; confirmLimit?: boolean; [k: string]: unknown }): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  apply(resources: unknown[], opts?: { dryRun?: boolean }): Promise<unknown>;
  /** The sync stream's server messages for these topics, read only. */
  events(topics: string | string[], opts?: { signal?: AbortSignal }): AsyncGenerator<{ t: string; [k: string]: unknown }>;
  /** Until the task stops working (or `until` says so), live. */
  wait(id: string, opts?: { until?: (t: Task) => boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<Task>;
}
