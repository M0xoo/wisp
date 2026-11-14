// Every row shape and port this plugin reads, in one file (docs/v2-ui-brief.md): when
// packages/protocol/src/generated/ exports the Rust rows (ts-rs), this file re-exports them. Until
// then the truth is v1's session JSON (server/runner.js summarize() and the full session), GET
// /agents, /projects, crew and My Stuff, and plugins/runtime/api/src/model.rs for the queue.

import type { DeepReadonly, EntityKey, PeerId } from '@wisp/client';
import type { ExtensionProps, ShellContext } from '@wisp/shell';
import type { Platform } from '@wisp/shell';

/** plan: read-only · edits: auto-accept file edits · auto: no permission prompts (v1 runners.js MODES). */
export type Mode = 'plan' | 'edits' | 'auto';
export const MODES: readonly Mode[] = ['plan', 'edits', 'auto'];
export const DEFAULT_MODE: Mode = 'auto';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** How a follow-up or a launch runs: harness, model, thinking level, account ('' = the default). */
export interface Runner {
  agent: string;
  model: string;
  effort: string;
  account?: string;
}

/** A follow-up waiting for the run to finish (runtime's QueueItem, v1 field names). */
export interface QueueItem {
  id: string;
  text: string;
  attachments?: Attachment[];
  at?: number;
  /** wisp's own items (reports back, repairs) can't be edited or combined */
  by?: 'wisp' | 'later' | 'compact' | (string & {});
  mode?: Mode;
  run?: Partial<Runner>;
  /** interrupting: goes ahead of the rest */
  now?: boolean;
}

/** What the task is waiting on you for; what's typed in the reply box answers it (design/ux.md). */
export interface Ask {
  kind: 'question' | 'permission' | 'clash';
  /** a clash: whose version the answer keeps */
  by?: string;
}

export type SessionState = 'running' | 'waiting' | 'review' | 'done' | 'error';

/** A task: the list's summary plus the full session's fields the composer reads. */
export interface Session {
  id: string;
  title: string;
  agent: string;
  model?: string;
  effort?: string;
  account?: string;
  mode?: Mode;
  cwd?: string;
  scratch?: boolean;
  projectId?: string | null;
  state: SessionState;
  live?: string;
  pending?: boolean;
  queue?: QueueItem[];
  queueHeld?: boolean;
  ask?: Ask | null;
  /** the list's flags for the same thing */
  asks?: boolean;
  approval?: boolean;
  /** open in the agent's own terminal: carry on there */
  tui?: boolean;
  parentId?: string;
  sideOf?: { id: string; title: string };
  /** a reminder, the tour: no agent to follow up with */
  kind?: string;
  machine?: { id: string; name: string } | null;
  btw?: BtwEntry[];
  createdAt?: number;
  updatedAt?: number;
}

export interface BtwEntry {
  id: string;
  question: string;
  status: 'running' | 'done' | 'error';
  askedAt: number;
  agent?: string;
  attachments?: Attachment[];
  answer?: string;
}

export interface Model {
  id: string;
  label: string;
  hint?: string;
  efforts?: string[];
}

export interface Account {
  id: string;
  label?: string;
  email?: string;
  default?: boolean;
  state?: 'ready' | 'limit' | 'signedOut';
  until?: number;
}

/** A harness the peer offers (v1 GET /agents). */
export interface Agent {
  id: string;
  name: string;
  available?: boolean;
  models?: Model[];
  efforts?: string[];
  /** wisp can give it tools, so it can lead a team */
  delegates?: boolean;
  signedIn?: boolean;
  accounts?: Account[];
}

export type ColorName = 'violet' | 'teal' | 'amber' | 'rose' | 'sky' | 'lime' | 'orange' | 'indigo' | 'slate';

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: ColorName;
  machine?: string;
  lastUsedAt?: number;
  addedAt?: number;
  /** still being cloned: can't start a task in it yet */
  cloning?: boolean;
}

export interface CrewMember {
  id: string;
  name: string;
  role?: string;
  color?: ColorName;
}

export interface StuffItem {
  id: string;
  title: string;
  kind?: string;
}

/** One delegate the lead may hand work to (v1 team.js member). */
export interface TeamMember {
  name: string;
  agent: string;
  model: string;
  effort: string;
  use: string;
  count: number;
}

export type Row<T> = DeepReadonly<T>;
export type { EntityKey, PeerId };

export const KIND = {
  session: 'session',
  agent: 'agent',
  project: 'project',
  crew: 'crew',
  stuff: 'stuff',
  plan: 'plan',
} as const;

// ---------- ports the shell hands in (asked for in the report; all optional, the box degrades) ----------

export type DictationError = 'denied' | 'blocked' | 'silence' | 'network' | 'busy' | 'audio' | 'failed';
export type DictationEvent =
  | { readonly state: 'listening' }
  | { readonly state: 'partial' | 'final'; readonly text: string }
  | { readonly state: 'error'; readonly error: DictationError }
  | { readonly state: 'end' };

/** Speech to text (the Android app's SpeechRecognizer; a browser's Web Speech where offered). */
export interface Dictation {
  /** starts listening; the returned function stops it (the final result still arrives) */
  start(onEvent: (e: DictationEvent) => void): () => void;
}

/** Bytes go up out of band: a command carries only the ids (v1 POST /api/uploads). */
export type Upload = (peer: PeerId, file: File, signal: AbortSignal) => Promise<Attachment>;

/**
 * What the reply box and New task read from the shell. The shell's context has all of it but these
 * three, asked for in the report (additive): dictation on the platform module, an uploader, and the
 * crew rail's pick. Each is optional: without it the mic, the paperclip or the For chip don't show.
 */
export type Services = ShellContext & {
  readonly platform: Platform & { readonly dictation?: Dictation };
  readonly upload?: Upload;
  readonly crewPick?: () => Row<CrewMember> | undefined;
};

export type ComposerProps = ExtensionProps;
