// The runner's operations, as one interface its modules call each other through. v1 had them as
// methods of one 2,000-line class (server/runner.js); each concern is its own file here, and
// runner/index.ts wires them, so no file imports another's code in a loop (tools/check: cycles).

import type { Json } from '@wisp/kernel';
import type { Attachment, HarnessEvent } from '@wisp-plugin/runtime-api';
import type { Ask, Delegation, Held, Member, Mode, QueueItem, RunOpts, Session, Turn } from '../model.ts';
import type { Rt } from '../rt.ts';

/** v1 create()'s options. Fields other plugins own travel in `ext`. */
export interface CreateOpts {
  id?: string;
  prompt: string;
  cwd: string;
  workdir?: string;
  dirs?: string[];
  agent?: string;
  mode?: Mode;
  model?: string;
  effort?: string;
  account?: string;
  attachments?: Attachment[];
  groupId?: string | null;
  origin?: Json | null;
  subagents?: Member[];
  parentId?: string | null;
  member?: string;
  history?: Turn[];
  title?: string;
  moved?: Json | null;
  kind?: string;
  relay?: Session['relay'] | null;
  delegated?: Session['delegated'] | null;
  forkedFrom?: Session['forkedFrom'] | null;
  sideOf?: Session['sideOf'] | null;
  sharedFrom?: Json | null;
  /** a held first turn (Ask near the limit): the hold an interceptor asked for */
  hold?: HoldSpec | null;
  /** an imported task with nothing asked yet: its history shows and it waits for a follow-up */
  idle?: boolean;
  tui?: boolean;
  subagentModel?: string;
  skills?: string;
  trial?: Json | null;
  capped?: Session['capped'] | null;
  /** its blocks carry what wisp acts on (a crew job's): it answers with them even with wisp blocks off */
  keepBlocks?: boolean;
  /** who started it by hand (not a crew job, schedule, trigger or subagent): the account pick skips one at its limit */
  byHand?: boolean;
  ext?: Record<string, Json>;
}

/** What holds a turn before it starts (v1 hold: a guard line, a changed harness, project trust). */
export interface HoldSpec {
  by: string;
  reason: string;
  agent: string;
  until?: number;
  project?: Held['project'];
  harness?: Json;
  [k: string]: unknown;
}

export type ReplyOpts = RunOpts & {
  queue?: boolean;
  hold?: HoldSpec | null;
};

export interface ReplyOut {
  answered?: boolean;
  held?: boolean;
  queued?: boolean;
  ahead?: number;
  interrupted?: boolean;
  turnId?: string;
}

/** A finished run as the runner reads it (a harness result, or one wisp made up: stop, restart). */
export interface ResultEv {
  text?: string;
  isError?: boolean;
  stopped?: boolean;
  stats?: Record<string, unknown> | null;
  stopReason?: string;
  authFailed?: boolean;
  background?: number;
}

export interface Reason {
  title?: string;
  summary?: string;
  blocks?: { type: string; [k: string]: unknown }[];
}

export interface Engine {
  readonly rt: Rt;
  touch(s: Session, o?: { turn?: Turn | undefined; quiet?: boolean; now?: boolean }): void;
  touchLead(child: Session): void;
  create(o: CreateOpts): Session;
  startTurn(s: Session, prompt: string, attachments?: Attachment[], opts?: RunOpts): void;
  holdTurn(s: Session, prompt: string, attachments: Attachment[], opts: RunOpts, hold: HoldSpec): void;
  releaseHeld(s: Session): boolean;
  reply(s: Session, text: string, attachments?: Attachment[], opts?: ReplyOpts): ReplyOut;
  startQueued(s: Session, next: QueueItem): void;
  switchRun(s: Session, run: NonNullable<RunOpts['run']>): void;
  switchAccount(s: Session, want: string): void;
  accountFor(agent: string, want?: string, byHand?: boolean): string;
  stop(s: Session): void;
  interrupt(s: Session): void;
  settle(s: Session, o?: { quiet?: boolean; from?: string }): void;
  finishTurn(s: Session, turn: Turn, ev: ResultEv, reason?: Reason | string): void;
  onEvent(s: Session, turn: Turn, ev: HarnessEvent | WispEvent): 'waiting' | undefined;
  ask(s: Session, a: Partial<Ask> & { question?: string }): string;
  answer(s: Session, text: string): boolean;
  reportBack(lead: Session, o?: { ending?: boolean }): boolean;
  delegateDone(child: Session, turn: Turn): void;
  awaiting(lead: Session): Delegation[];
  /** Auto's check, a goal round: whoever wants this turn first, or none */
  afterWanting(s: Session, turn: Turn, ev: { stopped?: boolean; isError?: boolean }, from?: string): string | null;
  runAfter(s: Session, turn: Turn, id: string): void;
  cancelAfter(s: Session, o: { stop?: boolean; by?: string }): boolean;
  stopSides(s: Session): void;
  note(s: Session, turn: Turn, o: { kind?: string; label: string }): void;
}

/** Events wisp itself feeds a turn (a live approval's answer, an ask): never from a harness. */
export type WispEvent = { type: 'tool'; kind: 'ask' | 'answer' | 'background' | 'check' | 'agent' | string; label: string };
