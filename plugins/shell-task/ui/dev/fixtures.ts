// Row builders for the dev page and the tests: v1-shaped tasks, turns and events with sane
// defaults, so a fixture names only what it is about. Dev-only.
import type { Activity, EventRow, Task, Turn } from '../src/types.ts';
import type { MockRow } from './mock-peer.ts';

export const T0 = 1_762_560_000_000; // 2025-11-08, a fixed clock for goldens

export function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 'Rate limit on /login',
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    mode: 'auto',
    cwd: '/Users/me/code/wisp',
    project: 'wisp',
    color: 'violet',
    state: 'review',
    status: 'done',
    createdAt: T0,
    updatedAt: T0 + 60_000,
    turnCount: 1,
    queued: 0,
    branch: 'wisp/rate-limit-login',
    ...over,
  };
}

export function turn(over: Partial<Turn> & { id: string; sessionId: string }): Turn {
  return {
    idx: 0,
    prompt: 'Add a rate limit to /login: 5 attempts per minute per IP.',
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    mode: 'auto',
    attachments: [],
    status: 'done',
    startedAt: T0,
    endedAt: T0 + 95_000,
    stats: { costUsd: 0.42, inputTokens: 18_200, outputTokens: 3_100, ms: 95_000 },
    presentation: null,
    nEvents: 0,
    ...over,
  };
}

/** Events for one turn, numbered from `seq`. */
export function events(sessionId: string, turnId: string, seq: number, acts: readonly Activity[]): EventRow[] {
  return acts.map((a, i) => ({ ...a, seq: seq + i, session_id: sessionId, turn_id: turnId, at: T0 + i * 1000 }) as EventRow);
}

export const rowsOf = (e: string, list: readonly { id: string }[]): MockRow[] => list.map((v) => ({ e, id: v.id, v }));
