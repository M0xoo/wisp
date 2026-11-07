// @wisp-plugin/runtime-api: the contract of wisp.runtime, the plugin that owns tasks (sessions),
// their turns and activity, the follow-up queue and the harness lifecycle. Every other plugin that
// starts, reads or reacts to a task depends on this package only (ADR-0003).
//
// Shapes follow v1's session JSON (server/runner.js, server/store.js) so the importer maps 1:1. Fields
// other plugins own (goal, auto, forLater, reminder, watch, worktree, crew, …) live in `ext`, namespaced
// by the owning plugin id: runtime never reads them, and their owner contributes them to the summary row
// through the `runtime.summary` point.

import type { Brand, Json } from '@wisp/kernel';

export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;

export type SessionState = 'running' | 'review' | 'done' | 'error';
export type TurnStatus = 'running' | 'done' | 'error' | 'held' | 'stopped';
export type Mode = 'plan' | 'edits' | 'auto';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** the file on disk, set when the turn hands it to a harness (v1 attachments carried it) */
  path?: string;
}

/** One step of a turn's activity (the append-only event log). */
export type Activity =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text?: string }
  | { kind: 'tool'; tool: 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'tool'; label: string; file?: string; detail?: string; callId?: string; output?: string }
  | { kind: 'tool_output'; callId: string; text: string }
  | { kind: 'tool_error'; name: string; text: string }
  | { kind: 'blocked'; tool: string; detail: string; rule?: string }
  | { kind: 'notice'; text: string; tone?: 'info' | 'warn' | 'danger' };

export interface FileChange {
  file: string;
  op: 'add' | 'modify' | 'delete' | 'rename';
  edits: { before: string; after: string }[];
}

export interface TurnStats {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  ms?: number;
  models?: Record<string, Json>;
}

/** The answer's rendered form: the fenced `wisp` block, parsed and checked (block types: `runtime.block`). */
export interface Presentation {
  blocks: { type: string; [k: string]: unknown }[];
  /** the parser version that made it: a newer parser rebuilds it lazily */
  v: number;
}

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  idx: number;
  prompt: string;
  agent: string;
  model: string;
  effort: string;
  account?: string;
  mode: Mode;
  attachments: Attachment[];
  /** who sent it, when not the user: 'wisp' (a goal check), 'compact', 'later', 'crew', 'channel' */
  by?: string;
  status: TurnStatus;
  startedAt: number;
  endedAt: number | null;
  /** a turn waiting before it starts (a limit, a changed harness, project trust): who holds it and why */
  held?: { by: string; kind: string; until?: number; data: Json };
  stats: TurnStats | null;
  presentation: Presentation | null;
  /** the harness's own session id, to resume */
  resumeId?: string;
  /** final answer text (the last text activity) */
  text?: string;
  isError?: boolean;
  /** how many files the turn changed (v1 turn.changes.length; wisp.telemetry's turn_ended counts it) */
  changedFiles?: number;
  /** owned by other plugins, namespaced by plugin id */
  ext: Record<string, Json>;
}

export interface QueueItem {
  id: string;
  text: string;
  attachments: Attachment[];
  at: number;
  by?: string;
  opts?: Json;
}

export interface Session {
  id: SessionId;
  title: string;
  agent: string;
  model: string;
  effort: string;
  account?: string;
  mode: Mode;
  cwd: string;
  /** extra folders the task may touch */
  dirs: string[];
  state: SessionState;
  unread: boolean;
  archived: boolean;
  parentId?: SessionId;
  createdAt: number;
  updatedAt: number;
  queue: QueueItem[];
  queueHeld?: boolean;
  tags?: string[];
  /** owned by other plugins, namespaced by plugin id: `ext['wisp.goal']`, `ext['wisp.worktrees']`, … */
  ext: Record<string, Json>;
}

/** The list row: runtime's own fields plus what each plugin adds through `runtime.summary`. */
export interface Summary {
  id: SessionId;
  title: string;
  agent: string;
  model: string;
  effort: string;
  mode: Mode;
  cwd: string;
  state: SessionState;
  status: 'running' | 'held' | 'done' | 'blocked' | 'info' | (string & {});
  unread: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  queued: number;
  preview: string;
  live: string;
  parentId?: SessionId;
  /** contributed fields, flattened (v1 names kept for the wire: goal, forLater, branch, …) */
  [field: string]: unknown;
}

// ---------- commands (ids are permissions: `runtime:<verb>`) ----------

export interface StartArgs {
  prompt: string;
  agent?: string; // 'auto' lets wisp.router pick
  model?: string;
  effort?: string;
  mode?: Mode;
  cwd?: string;
  dirs?: string[];
  title?: string;
  attachments?: Attachment[];
  parentId?: SessionId;
  account?: string;
  by?: string;
  /** namespaced extras the caller's plugin stores on the new session (ext[callerPluginId]) */
  ext?: Record<string, Json>;
}

export interface FollowUpArgs {
  id: SessionId;
  text: string;
  attachments?: Attachment[];
  /** true: wait in the queue if a turn is running; false: interrupt and send now */
  queue?: boolean;
  mode?: Mode;
  run?: { agent?: string; model?: string; effort?: string };
  by?: string;
}

export const COMMANDS = {
  create: 'runtime.create', // StartArgs → { id }   (creates and starts)
  followUp: 'runtime.followUp', // FollowUpArgs → { turnId | queued }
  stop: 'runtime.stop', // { id, keepQueue?: true } → {}   (a stop never discards queued follow-ups)
  rename: 'runtime.rename', // { id, title } → {}
  archive: 'runtime.archive', // { id, archived } → {}
  markRead: 'runtime.markRead', // { id, unread } → {}
  setState: 'runtime.setState', // { id, state } → {}   (Mark done / Reopen)
  delete: 'runtime.delete', // { id } → {}
  queueEdit: 'runtime.queue.edit', // { id, items: QueueItem[] } → {}  (reorder, combine, remove)
  queueSendNow: 'runtime.queue.sendNow', // { id, itemId } → {}
  release: 'runtime.release', // { id, turnId, action: 'start' | 'skip' } → {}  (a held turn)
  get: 'runtime.get', // { id } → Session  (read-only)
  list: 'runtime.list', // { archived?, limit? } → Summary[]  (read-only)
  turns: 'runtime.turns', // { id, before?, limit? } → Turn[]  (read-only)
  activity: 'runtime.activity', // { id, turnId, sinceSeq? } → { seq, items: Activity[] }  (read-only)
  setExt: 'runtime.setExt', // { id, plugin, value } → {}   (a plugin writes its own ext slot only)
  // ---- added by the runtime port (v1 behaviour the list above didn't name; all additive) ----
  answer: 'runtime.answer', // { id, text } → { ok }   (an ask_user question or a live approval)
  ask: 'runtime.ask', // AskArgs → { askId }   (wisp's ask_user tool, from the MCP server)
  approval: 'runtime.approval', // { id, tool, input, toolUseId? } → { decision } | { id }  (a live approval)
  pollAnswer: 'runtime.pollAnswer', // { askId } → { answer… } | { pending } | { cancelled }  (read-only)
  approveBlocked: 'runtime.approveBlocked', // { id, turnId?, allow } → { denied } | { queued…, scoped }
  btw: 'runtime.btw', // { id, question, attachments? } → BtwEntry   (a /btw side question)
  btwDrop: 'runtime.btw.drop', // { id, btwId } → { ok }
  compact: 'runtime.compact', // { id } → { queued | turnId }   (Compact now)
  delegate: 'runtime.delegate', // { id, tasks: { subagent, prompt }[] } → Delegation[]   (the lead's delegate tool)
  results: 'runtime.results', // { id, ids?, wait? } → { reports }   (subagent_results)
  rerun: 'runtime.rerun', // { id, turnId, account? } → { rerun }   (a signed-out turn's Try again)
  signIn: 'runtime.signIn', // { id, turnId } → { armed }   (Sign in on the card reruns when it lands)
  signInDone: 'runtime.signInDone', // { agent, account } → {}   (a login finished: armed turns rerun)
  overage: 'runtime.overage', // { id, turnId, kind } → {}   (budget: this run was billed past the plan)
  note: 'runtime.note', // { id, turnId?, kind?, label } → {}   (a line in a turn's activity from wisp itself)
  settle: 'runtime.settle', // { id, quiet? } → {}   (an after-turn step is done with a task it held)
  turnExt: 'runtime.turn.setExt', // { id, turnId, plugin, value } → {}
  search: 'runtime.search', // { q, limit? } → SearchHit[]  (read-only)
  queueMerge: 'runtime.queue.merge', // { id, ids } → {}   (combine queued follow-ups)
  queueText: 'runtime.queue.text', // { id, itemId, text } → {}
  // added by the crew row (goal judges, Retro): v1 server/quick.js askJson, outside any task
  quick: 'runtime.quick', // QuickArgs → QuickResult   (one short model call; no session, no turn)
  // added by the edge row (wisp.telemetry's app_started, wisp.update's harness installer): v1 listAgents()
  agents: 'runtime.agents', // { fresh?: boolean } → AgentStatus[]  (read-only; fresh: detect again)
  // added by the crew row (wisp.later): v1 later.js #reminderTask, a reminder plan that came due
  card: 'runtime.card', // CardArgs → { id }   (a finished task with one done turn that ran no agent)
} as const;

/** `runtime.card`: a task that is only a message (v1 `kind: 'reminder'`): state review, unread, one done turn. */
export interface CardArgs {
  title: string;
  /** the turn's prompt, as the bubble shows it */
  prompt: string;
  /** the turn's answer blocks (a hero) */
  blocks: Presentation['blocks'];
  /** when the turn says it started (the plan's setAt) */
  startedAt?: number;
  cwd?: string;
  agent?: string;
  /** namespaced extras, as on StartArgs (ext['wisp.later'].kind = 'reminder' refuses follow-ups) */
  ext?: Record<string, Json>;
}

/** `runtime.agents`: each harness and what detect() found (v1 listAgents, minus the bin path). */
export interface AgentStatus {
  id: string;
  name: string;
  available: boolean;
  version?: string;
  error?: string;
}

/** `runtime.quick`: one short model call on the cheapest available harness, or the one named. */
export interface QuickArgs {
  prompt: string;
  cwd: string;
  /** pick this harness and model; default: the cheapest one available (v1 quick.js cheapest) */
  pick?: { agent: string; model?: string; effort?: string };
  timeoutMs?: number;
  /** the answer is a JSON object: parsed into `json` (v1 readJson), null when it isn't one */
  json?: boolean;
}
export interface QuickResult {
  text: string;
  json?: Json | null;
  agent: string;
  model: string;
  costUsd?: number;
  /** added by the crew row (goal-run records): what the call did, as a turn's activity, when kept */
  activity?: Activity[];
}

// ---------- events (published after commit) ----------

export const EVENTS = {
  created: 'session.created', // { session: Summary }
  started: 'turn.started', // { sessionId, turnId }
  activity: 'turn.activity', // { sessionId, turnId, items: Activity[] }  (coalesced)
  finished: 'turn.finished', // { sessionId, turnId, status, interrupted, summary: Summary }
  held: 'turn.held', // { sessionId, turnId, by, kind }
  changed: 'session.changed', // { id }
  deleted: 'session.deleted', // { id }
  // added by the runtime port
  ended: 'turn.ended', // { sessionId, turnId, status, interrupted, errorText }  (every end, quiet ones too)
  limits: 'turn.limits', // { sessionId, turnId, agent, account, limits }  (budget records them)
  asked: 'session.asked', // { sessionId, askId, question }  (a question waits for the user)
} as const;

// ---------- interceptor hooks ----------

export interface BeforeRunCtx {
  sessionId: SessionId;
  turnId: TurnId;
  agent: string;
  account?: string;
  model: string;
  mode: Mode;
  cwd: string;
  prompt: string;
  by?: string;
  /** set by an interceptor that holds the turn instead of refusing it */
  hold?: { by: string; kind: string; until?: number; data: Json };
  /**
   * The account's environment, set by wisp.accounts through `modify` (v1 runner #accountEnv:
   * CLAUDE_CONFIG_DIR, CODEX_HOME). The runtime passes it to `HarnessRun.accountEnv`.
   */
  accountEnv?: Record<string, string>;
  // added by the runtime port
  /** the run's permission mode for this turn only (an approved retry runs once in Full auto) */
  once?: Mode;
  /** set by project trust through `modify`: run without the repo's hooks and MCP servers */
  untrusted?: boolean;
  /** whether this is the task's first turn or a follow-up (the hold card says which) */
  kind?: 'first' | 'followUp';
  /** what the follow-up carried (a held turn keeps it, to send it as it was) */
  parentId?: SessionId;
}
export const HOOKS = {
  beforeRun: 'before:run', // BeforeRunCtx: budget, capped mode, side gate, guard, project trust
  beforeCreate: 'before:create', // StartArgs
  beforeFollowUp: 'before:followUp', // FollowUpArgs
  beforeDelegate: 'before:delegate', // { from: SessionId, to: StartArgs }
} as const;

// ---------- extension points ----------

export type * from './harness.ts';

/** `runtime.summary@1`: a plugin adds its fields to the list row from its ext slot (pure, fast). */
export interface SummaryField {
  plugin: string;
  fields(session: Session, last: Turn | undefined): Record<string, unknown>;
}

/** `runtime.prompt@1`: text appended to a turn's system prompt (learned preferences, plugin prompts). */
export interface PromptPart {
  id: string;
  part(session: Session): string | Promise<string>;
  /** added by the runtime port: text put ahead of one turn's prompt (a scheduled follow-up's note) */
  prefix?(session: Session, turn: Turn): string;
  /** added by the runtime port: text put after the prompt (what an @-mention of My Stuff points at) */
  expand?(prompt: string, session: Session, o: { tools: boolean }): string;
}

/** `runtime.block@1`: an answer block type the parser accepts (its JSON schema) and the UI renders. */
export interface BlockType {
  type: string;
  /** validates and normalises one block; returns null to drop it with a reason */
  check(block: Record<string, unknown>): { ok: true; block: Record<string, unknown> } | { ok: false; reason: string };
  /** added by the runtime port: how the agent is told to use it, appended to the protocol's block list */
  doc?: string;
  /** who adds it, as the agent is told ("From the user's spell <from>.") */
  from?: string;
}

/**
 * `runtime.view@1`: a projection of what a *client* sees of a task (the page, the phone, a peer),
 * never what is stored, what rollback reads or what the agent reads. v1's .env masking
 * (env-mask.js) is one: a .env file's values go to the page as KEY=••••. Each hook returns its input
 * as it is when it has nothing to change, so the runtime can skip the copy (`===`). `masked` on what
 * a hook returns is the query Reveal sends to see that one thing as stored.
 */
export interface ViewTransform {
  id: string;
  activity?(a: Activity & { masked?: string }, turnId: TurnId): Activity & { masked?: string };
  change?(c: FileChange & { beforeFile?: string | null; masked?: string }, turnId: TurnId): FileChange & { beforeFile?: string | null; masked?: string };
  block?(b: Presentation['blocks'][number], turnId: TurnId, index: number): Presentation['blocks'][number];
  /** free text a client is shown that may hold a diff (what a goal check was told) */
  text?(text: string): string;
}

// ---------- extension points added by the runtime port ----------
// v1's runner called other features through `app.*` (goals, the crew, connectors, accounts). Each
// of those calls is now a point its owner contributes to; the runtime never imports the owner.

/** `runtime.after@1`: a step after a turn ends, before the task lands (Auto's check, a goal round). */
export interface AfterTurn {
  id: string;
  /** lower asks first; the first that wants a turn holds the task in Working */
  order: number;
  wants(session: Session, turn: Turn, ev: { stopped?: boolean; isError?: boolean }): boolean;
  run(session: Session, turn: Turn): Promise<void>;
  /**
   * Someone else moved the task on: drop what it was about to do. stop: the user pressed Stop; by:
   * who sent the follow-up ('wisp', 'later', 'compact', or undefined for the user). true if it held one.
   */
  cancel(session: Session, o: { stop?: boolean; by?: string }): boolean;
  /** what it is doing with the task now, for the row's live line; null when idle */
  busy?(session: Session): string | null;
}

/** `runtime.run@1`: what a run gets besides its prompt: folders, env, MCP servers (connectors, wisp's tools). */
export interface RunPart {
  id: string;
  dirs?(session: Session): string[];
  env?(session: Session): Record<string, string>;
  mcpServers?(session: Session, o: { mode: Mode; harness: string; team: Json[]; turnId: string; sub: boolean }): Record<string, Json>;
}

/** `runtime.outcome@1`: how a finished turn lands (a crew check-in that found nothing files itself). */
export interface TurnOutcome {
  id: string;
  outcome(session: Session, turn: Turn): { quiet?: boolean; filed?: boolean; later?: boolean } | null;
}

/** `runtime.delegate@1`: delegation to a team member that isn't a plain harness (a crew member). */
export interface DelegateTarget {
  id: string;
  handles(member: Json): boolean;
  start(lead: Session, member: Json, prompt: string): Promise<{ id: string; agent: string; model: string; effort: string; turnId: string; place?: string } | { error: string }>;
  /** a job it started elsewhere, as last fetched, for the lead's reports */
  child?(id: string): Session | undefined;
}

/**
 * `runtime.accounts@1`: a harness's several accounts (wisp.accounts contributes one per harness).
 * Without one, a harness runs on the CLI's own login.
 */
export interface AccountsProvider {
  agent: string;
  multi(): boolean;
  get(id: string): { id: string; label: string; kind: string; state: string; until?: number } | undefined;
  list(): { id: string; label: string; kind: string; state: string }[];
  /** the account a run gets: `want` when it has it, else your last pick (byHand skips one at its limit) */
  pick(want: string, o: { byHand: boolean }): string;
  /** conversations stay with the login: another account starts a fresh one */
  perLogin?: boolean;
  /** the provider's own way past a limit ('' when none) */
  extra?: string;
  cool?(id: string, o: { ms: number; why: string }): void;
  /** when this account's usage window resets, if known */
  resetAt?(id: string): number | undefined;
  /** asks the CLI whether it is signed in (a signed-out turn's one question) */
  authStatus?(id: string): Promise<{ signedIn: boolean } | null>;
  /** its CLI's words for a run that is signed out */
  signedOut?(text: string): boolean;
  /** signs in with an API key: the card says Add your API key */
  keyLogin?: boolean;
}

export const POINTS = {
  harness: 'runtime.harness',
  summary: 'runtime.summary',
  prompt: 'runtime.prompt',
  block: 'runtime.block',
  view: 'runtime.view',
  // added by the runtime port
  after: 'runtime.after',
  run: 'runtime.run',
  outcome: 'runtime.outcome',
  delegate: 'runtime.delegate',
  accounts: 'runtime.accounts',
} as const;

export const TOPIC_LIST = 'list';
export const sessionTopic = (id: string): `session:${string}` => `session:${id}`;
