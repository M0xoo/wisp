// Small things every part of wisp.ship uses: v1's error shape (a status the edge keeps), the loose
// session shape runtime.get answers with, and reading the slots other plugins own.

import type { Json } from '@wisp/kernel';

/** v1's bad(msg, status): a refusal the route sends as { error } with that status. */
export function bad(message: string, status = 400): Error {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'invalid';
  return Object.assign(new Error(message), { code, status, retry: false });
}

export const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const statusOf = (e: unknown): number | undefined => {
  const s = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
};

/** What wisp.ship reads of a session (runtime's Session, plus the v1 fields runtime keeps on it). */
export interface Sess {
  id: string;
  title: string;
  agent: string;
  cwd: string;
  state: string;
  unread?: boolean;
  archived?: boolean;
  parentId?: string;
  updatedAt?: number;
  queue?: unknown[];
  ext: Record<string, Json>;
  sideOf?: unknown;
  ask?: unknown;
}

/** v1 side.js notSide: a side discussion can't act on the main task's work. */
export function notSide(s: Sess, what = 'change the work'): void {
  if (s.sideOf) throw bad(`A side discussion can't ${what}: that stays with the main task. Do it on the main task.`, 409);
}
