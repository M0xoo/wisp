// The task, the context and the phone as a channel sees them: the shapes of v1's session JSON and
// services/phone.js that the hub and every transport read. Re-exported by index.ts.

import type { Json } from '@wisp/kernel';
import type { Mode } from '@wisp-plugin/runtime-api';

// ---------- messages ----------

export type ActionKind = 'answer' | 'reply' | 'done';

export interface Action {
  label: string;
  kind: ActionKind;
  /** the ask id (answer) or the turn id (reply, done) */
  ref: string;
  index: number;
}

/** What the hub sends: v1 Remote.message(). */
export interface Msg {
  title: string;
  text: string;
  actions: Action[];
}

/** A signed tap (ntfy's buttons, Telegram's callback data): `{ s, k, r, i, sig }`. */
export interface Signed {
  s: string;
  k: string;
  r: string;
  i: number | string;
  sig: string;
}

// ---------- the task as a channel sees it ----------

/** An ask a task waits on (wisp.mcp's ask_user, approve, a clash card, a connector's sign-in). */
export interface AskView {
  id: string;
  question?: string;
  options?: string[];
  context?: string;
  permission?: { tool?: string; action?: string; detail?: string; why?: string };
  clash?: Json;
  connector?: Json;
}

export interface BlockView {
  type: string;
  [k: string]: unknown;
}

export interface TurnView {
  id: string;
  status: string;
  model?: string;
  stats?: { totals?: Json; models?: Record<string, Json>; [k: string]: unknown } | null;
  presentation?: { blocks: BlockView[] } | null;
  btw?: { id: string; status: string; answer?: string; error?: string }[];
}

/** What a channel keeps about a task (v1 s.remote): where it started, its thread there. */
export interface Remote {
  /** the channel it was started from */
  started?: string;
  /** who started it, by display name */
  by?: string;
  /** Telegram: the messages its reports go under, oldest first */
  tg?: number[];
  /** a routed thread (the grid's) */
  routed?: string;
  /** per-transport thread data: `slack: { channel, ts }`, `github: { repo, issue }`, … */
  [channel: string]: Json | undefined;
}

/** v1's session JSON, the part channels read. `remote` is channels' own row (table channels_thread). */
export interface SessionView {
  id: string;
  title: string;
  /** v1's states: 'waiting' when an ask is open */
  state: 'running' | 'waiting' | 'review' | 'done' | 'error' | (string & {});
  agent: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  cwd?: string;
  kind?: string;
  parentId?: string;
  sideOf?: { id: string };
  crew?: { id?: string; job?: string; from?: { id: string } };
  capped?: { mode: Mode } | null;
  ask?: AskView | null;
  queue?: unknown[];
  queueHeld?: boolean;
  delegated?: boolean;
  tui?: boolean;
  turns: TurnView[];
  remote?: Remote;
}

/** The list row the phone's message reads (project name, preview). */
export interface SummaryView {
  project?: string;
  preview?: string;
}

/** Where a task started from a channel answers (kept with a crew job that has to wait). */
export interface Thread {
  channel: string;
  ref?: string;
  session?: string;
  ack?: unknown;
  [k: string]: unknown;
}

// ---------- what channels needs of wisp (v1 services/phone.js) ----------

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  machine?: string;
  repo?: string;
  lastUsedAt?: number;
  addedAt?: number;
}

export interface ModelView {
  id: string;
  label?: string;
  efforts?: string[];
}

export interface AgentView {
  id: string;
  name?: string;
  available?: boolean;
  signedIn?: boolean;
  models?: ModelView[];
  efforts?: string[];
}

export interface MachineView {
  id: string;
  name: string;
  kind?: string;
  computer?: boolean;
  usable?: boolean;
  agents?: AgentView[] | null;
}

export interface MemberView {
  id: string;
  name: string;
  role?: string;
  agent: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  cwd?: string;
  machine?: string;
  sandbox?: boolean;
  paused?: boolean;
  running?: number;
  queue?: unknown[];
}

/** A harness as the lists read it: its name and what it really runs in a mode. */
export interface AdapterView extends AgentView {
  modelOverride?(o: { model: string; mode: Mode }): { label: string; note: string } | null;
}

/** Everything a message may pick from (grammar, lists). */
export interface ChannelCtx {
  projects: ProjectView[];
  machines: MachineView[];
  agents: AgentView[];
  adapters: AdapterView[];
  crew: MemberView[];
  crewView?: MemberView[];
  goals: string[];
  defaultProject: ProjectView | null;
  defaultAgent: string;
  sandbox: boolean;
  tasks: { id: string; title: string; state: string }[];
  /** in a task's thread: where its follow-up runs */
  thread?: { agent: string; machine: string } | undefined;
  /** a router's grammar: whole names only */
  exact?: boolean;
}

/** grammar.parseMessage's answer. */
export interface Parsed {
  command: string | null;
  arg: string;
  crew: MemberView | null;
  tagged: MemberView[];
  project: ProjectView | null;
  machine: string | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  mode: Mode | null;
  prompt: string;
  problems: Problem[];
  notes: string[];
}

export interface Problem {
  kind: string;
  text: string;
  choices: string[];
}

export interface StartOpts {
  channel: string;
  name: string;
  sender?: string;
  /** the most this chat may ask for */
  cap?: Mode;
  /** the mode when none was asked for */
  fallback?: Mode;
  about?: string;
  thread?: Thread | null;
  ctx?: ChannelCtx | null;
}

export interface RunOpts {
  name: string;
  sender?: string;
  cap?: Mode;
  later?: ((text: string) => void) | undefined;
  btw?: boolean;
  about?: string;
  /** false: a channel that can't answer a tool approval */
  approvals?: boolean;
}

export interface ActArgs {
  sessionId: string;
  kind: ActionKind | 'text';
  ref?: string;
  index?: number;
  text?: string;
  later?: (text: string) => void;
  approvals?: boolean;
}

/** v1 phoneActions(app): what the channel layer asks of wisp. The host implements it with commands. */
export interface Phone {
  context(): Promise<ChannelCtx>;
  /** counts only, and only fixed values: never what a message said */
  count(kind: string, detail?: string): void;
  /** a routed message's way back: through the grid, which holds the bot */
  onGrid(): boolean;
  gridReply(thread: string, text: string): Promise<unknown>;
  /** a queued job's thread got its first reply */
  threadSaved(): void;
  threadCtx(sessionId: string): Promise<{ agent: string; machine: string }>;
  startParsed(p: Parsed, o: StartOpts): Promise<{ ack: string; session?: SessionView; queued?: number }>;
  stop(sessionId: string): Promise<string>;
  status(sessionId: string): Promise<string>;
  run(sessionId: string, p: Parsed, o: RunOpts): Promise<string>;
  mention(sessionId: string, p: Parsed, o: StartOpts): Promise<{ ack: string; queued?: number }>;
  launch(o: { project: ProjectView; prompt: string }): Promise<SessionView | null>;
  act(a: ActArgs): Promise<string>;
  /** the user's projects (the default project, Telegram's /new) */
  projects(): Promise<ProjectView[]>;
  /** a task here or on a machine (`<id>@<machine>`), with its turns and ask, or null */
  session(id: string): Promise<SessionView | null>;
  /** running or waiting top-level tasks here (status lists, a thread's lookups) */
  sessions(): Promise<SessionView[]>;
}
