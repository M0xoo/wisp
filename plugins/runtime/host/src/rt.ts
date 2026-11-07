// What every part of the runtime shares: the store door, the runs in flight, the extension points
// and the kernel services. v1 kept these as fields of one Runner class (server/runner.js); here
// they are one object the runner's modules take, so each concern is its own file.

import type { Clock, Json, Log, Scope } from '@wisp/kernel';
import type { AccountsProvider, AfterTurn, BlockType, DelegateTarget, Harness, PromptPart, RunPart, SummaryField, TurnOutcome, ViewTransform } from '@wisp-plugin/runtime-api';
import type { Persist } from './persist.ts';

/** A run in flight: the harness's handle plus the release that ends it exactly once. */
export interface Live {
  stop(): void;
  done: Promise<void>;
  release(): void;
}

export interface AnswerOut {
  answer?: string;
  decision?: 'allow' | 'deny';
  always?: boolean;
  message?: string;
}

export interface SideRun {
  sessionId: string;
  handle: { stop(): void; done: Promise<void> };
  timedOut: boolean;
}

export interface SignIn {
  sessionId: string;
  agent: string;
  account: string;
  until: number;
}

export interface Points {
  harness(id: string): Harness | undefined;
  harnesses(): readonly Harness[];
  summary(): readonly SummaryField[];
  prompt(): readonly PromptPart[];
  block(): readonly BlockType[];
  after(): readonly AfterTurn[];
  run(): readonly RunPart[];
  outcome(): readonly TurnOutcome[];
  delegate(): readonly DelegateTarget[];
  accounts(agent: string): AccountsProvider | undefined;
  view(): readonly ViewTransform[];
}

export interface Settings {
  get<T extends Json>(key: string): T | undefined;
}

export interface Rt {
  readonly clock: Clock;
  readonly log: Log;
  readonly scope: Scope;
  readonly db: Persist;
  readonly points: Points;
  readonly settings: Settings;
  /** ~/.wisp (scratch folders, kept screenshots) */
  readonly home: string;
  /** how wisp's own MCP server reaches the API; null in tests and on a box without one */
  bridge: { url: string; token: string } | null;
  /** runs every interceptor of a hook in order; rejects with `vetoed` when one refuses */
  hook<C>(hook: string, ctx: C): Promise<C>;
  /** publishes a plugin event once the rows it describes have committed */
  emit(type: string, data: Json): void;
  readonly live: Map<string, Live>;
  readonly stopping: Set<string>;
  readonly interrupting: Set<string>;
  /** ids whose run ended with a follow-up waiting to start: they stay in Working */
  readonly handing: Set<string>;
  /** ids being deleted: their run ends quietly */
  readonly deleting: Set<string>;
  readonly answers: Map<string, AnswerOut>;
  readonly sides: Map<string, SideRun>;
  readonly signIns: Map<string, SignIn>;
  /** a clash card's ask id → the tool call it holds (side gate) */
  readonly sidePending: Map<string, unknown>;
}

export const setting = (rt: Rt, key: string): string => {
  const v = rt.settings.get<Json>(`runtime.${key}`);
  return typeof v === 'string' ? v : '';
};
