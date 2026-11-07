// Typings for `wisp-agents/client`. Shapes the server owns are loose on purpose: the fields named
// here are the ones the CLI reads, and everything else passes through as unknown.

export declare const DEFAULT_PORT: 4477;

/** Loose server object: the named fields plus whatever else the server sends. */
export type Loose<T> = T & Record<string, unknown>;

export type Effort = string;
export type Mode = 'auto' | 'plan' | (string & {});
export type SessionState = 'running' | 'waiting' | 'review' | 'done' | 'error' | (string & {});

export interface ServerInfo extends Record<string, unknown> {
  port?: number;
  pid?: number;
  url?: string;
}

export interface TryChange {
  subagentModel?: '' | 'haiku' | 'sonnet';
  skills?: 'off';
}

export declare function tryRuns(list: readonly string[]): TryChange;
export declare function tryProblem(opts: { agent?: string; compare?: unknown; mode?: string; worktree?: boolean }): string | null;
export declare function wispHome(): string;
export declare function discover(home?: string): ServerInfo | null;
export declare function parseFrame(frame: string): WispEvent;

export declare class WispError extends Error {
  constructor(message: string, status: number, body?: unknown);
  name: 'WispError';
  /** HTTP status; 0 when wisp could not be reached or started. */
  status: number;
  body: unknown;
}

export interface ClientOptions {
  url?: string;
  port?: number;
}

export interface ConnectOptions extends ClientOptions {
  /** Start a headless wisp when none answers (default true). */
  start?: boolean;
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Return the raw Response instead of parsed JSON (successful responses only). */
  raw?: boolean;
  signal?: AbortSignal;
}

export type Health = Loose<{ ok?: boolean; version?: string }>;
export type Config = Loose<{ defaults?: Loose<{ agent?: string; mode?: string; model?: string; models?: Record<string, string> }> }>;
export type Agent = Loose<{ id: string; name?: string; available?: boolean; version?: string; models?: Loose<{ id?: string }>[] }>;
export type Machine = Loose<{ id: string; name?: string; kind?: string; state?: string }>;
export type Project = Loose<{ id: string; name?: string; path?: string }>;
export type CrewMember = Loose<{ id: string; name?: string; handle?: string; role?: string }>;
export type Recipe = Loose<{ id?: string; name?: string; prompt?: string }>;
export type Upload = Loose<{ id: string; name?: string; type?: string; size?: number }>;

export type Btw = Loose<{ id: string; question?: string; status: 'running' | 'done' | 'error' | (string & {}); answer?: string; error?: string }>;
export type Turn = Loose<{ id?: string; btw?: Btw[] }>;

export type SessionSummary = Loose<{
  id: string;
  title?: string;
  state?: SessionState;
  cwd?: string;
  agent?: string;
  model?: string;
  unread?: boolean;
  archived?: boolean;
}>;
export type Session = SessionSummary & { turns?: Turn[] };
export type WaitResult = SessionSummary & { timedOut?: boolean };
export type Presentation = Loose<{ markdown?: string }>;

export interface SessionFilter {
  /** One state or a comma-separated list. */
  state?: string;
  cwd?: string;
  project?: string;
  archived?: boolean;
  limit?: number;
}

export interface SessionPatch extends Record<string, unknown> {
  title?: string;
  state?: SessionState;
  unread?: boolean;
  archived?: boolean;
  forLater?: boolean;
}

export interface RunChoice {
  agent?: string;
  model?: string;
  effort?: Effort;
  subagentModel?: '' | 'haiku' | 'sonnet';
  skills?: 'off';
}

export interface Subagent {
  name: string;
  agent?: string;
  model?: string;
  effort?: Effort;
  use?: string;
}

export interface LaunchOptions {
  prompt?: string;
  cwd?: string;
  also?: string[];
  agent?: string;
  mode?: Mode;
  model?: string;
  effort?: Effort;
  attachments?: string[];
  worktree?: boolean;
  compare?: RunChoice[];
  subagents?: Subagent[];
  preset?: string;
  kind?: string;
  machine?: string;
  confirmLimit?: boolean;
  subagentModel?: '' | 'haiku' | 'sonnet';
  skills?: 'off';
  trial?: boolean | Record<string, unknown>;
}

export interface ReplyOptions {
  attachments?: string[];
  queue?: boolean;
  mode?: Mode;
  agent?: string;
  model?: string;
  effort?: Effort;
  confirmLimit?: boolean;
}

export interface RunRecipeOptions {
  params?: Record<string, string>;
  words?: string;
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: Effort;
  mode?: Mode;
}

export type JsonObject = Record<string, unknown>;

export interface WispEvent {
  event: 'summary' | 'activity' | 'turn' | 'finished' | 'removed' | 'config' | 'ping' | 'message' | (string & {});
  /** Parsed JSON, the raw text when it isn't JSON, or null when the frame had no data. */
  data: unknown;
}

export declare class WispClient {
  constructor(opts?: ClientOptions);
  readonly url: string;
  static connect(opts?: ConnectOptions): Promise<WispClient>;

  request<T = JsonObject>(method: string, path: string, body?: unknown, opts?: RequestOptions & { raw?: false }): Promise<T>;
  request(method: string, path: string, body: unknown, opts: RequestOptions & { raw: true }): Promise<Response>;
  ping(): Promise<boolean>;

  health(): Promise<Health>;
  agents(): Promise<Agent[]>;
  config(): Promise<Config>;
  machines(): Promise<Machine[]>;
  updateConfig(patch: JsonObject): Promise<Config>;

  projects(): Promise<Project[]>;
  addProject(dir: string, opts?: { name?: string }): Promise<Project>;
  removeProject(id: string): Promise<JsonObject>;

  crew(): Promise<CrewMember[]>;
  crewMember(id: string): Promise<CrewMember>;
  addCrew(member: JsonObject): Promise<CrewMember>;
  updateCrew(id: string, patch: JsonObject): Promise<CrewMember>;
  removeCrew(id: string): Promise<JsonObject>;
  importCrew(body: { text?: string; url?: string; choices?: unknown; dryRun?: boolean }): Promise<JsonObject>;
  exportCrew(body: { ids?: string[]; kit?: boolean; notebook?: boolean; team?: boolean; gist?: boolean }): Promise<JsonObject>;

  sessions(filter?: SessionFilter): Promise<SessionSummary[]>;
  session(id: string): Promise<Session>;
  presentation(id: string, opts?: { turn?: string | number }): Promise<Presentation>;
  update(id: string, patch: SessionPatch): Promise<SessionSummary>;
  remove(id: string): Promise<JsonObject>;
  stop(id: string): Promise<JsonObject>;
  answer(id: string, text: string): Promise<JsonObject>;
  revert(id: string, file: string, opts?: JsonObject): Promise<JsonObject>;
  revert(id: string, opts?: JsonObject): Promise<JsonObject>;
  rollback(id: string, opts?: { turnId?: string; restore?: boolean }): Promise<JsonObject>;
  exec(id: string, command: string, opts?: JsonObject): Promise<JsonObject>;
  exec(id: string, opts?: JsonObject & { command?: string }): Promise<JsonObject>;
  takeover(id: string, opts?: { open?: boolean }): Promise<JsonObject>;

  launch(opts?: LaunchOptions): Promise<SessionSummary>;
  ship(id: string, opts?: { title?: string; body?: string; draft?: boolean }): Promise<Loose<{ url?: string }>>;
  merge(id: string): Promise<JsonObject>;

  recipes(): Promise<Recipe[]>;
  saveRecipe(recipe: Recipe): Promise<Recipe>;
  runRecipe(key: string, opts?: RunRecipeOptions): Promise<SessionSummary>;
  triggers(): Promise<JsonObject>;
  usage(opts?: { days?: number }): Promise<JsonObject>;

  reply(id: string, text: string, opts?: ReplyOptions): Promise<Loose<{ answered?: boolean; interrupted?: boolean; queued?: boolean }>>;
  btw(id: string, text: string, opts?: { attachments?: string[]; wait?: true; timeoutMs?: number }): Promise<Btw>;
  btw(id: string, text: string, opts: { attachments?: string[]; wait: false }): Promise<Loose<{ id: string }>>;
  btwAnswer(id: string, btwId: string, opts?: { timeoutMs?: number }): Promise<Btw>;
  upload(file: string | Uint8Array | ArrayBuffer, opts?: { name?: string; type?: string }): Promise<Upload>;
  wait(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  events(opts?: { signal?: AbortSignal }): AsyncGenerator<WispEvent, void, undefined>;
}
