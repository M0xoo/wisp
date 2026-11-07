// Triggers and tasks (v1 Triggers.taskEvent, #skips, #watches, #taskFor): a task finished, or was
// marked done, and the triggers of that kind that watch it fire, each at most 3 times per task; a CI
// failure on a branch that already has a task goes to that task as a follow-up.

import path from 'node:path';
import { EXT, TASK_KINDS } from '@wisp-plugin/automations-api';
import { COMMANDS as RT } from '@wisp-plugin/runtime-api';
import type { Session, Summary, Turn } from '@wisp-plugin/runtime-api';
import type { Engine, Started } from './engine.ts';
import type { Trigger } from './types.ts';
import { isObj } from './util.ts';

const MAX_PER_TASK = 3; // a verifier and the task's agent mustn't bounce one task back and forth for ever
const MAX_SEEN = 200;

/** A task as the triggers read it: the session, its row's fields, and its last report. */
export interface TaskInfo {
  id: string;
  title: string;
  cwd: string;
  agent: string;
  account?: string;
  state: string;
  archived: boolean;
  parentId?: string;
  /** a delegate, a side kind (btw, judge, …): helpers no watcher reacts to */
  helper: boolean;
  origin: { kind: string; id: string } | null;
  crew: { id: string; job?: string } | null;
  branch: string;
  summary: string;
  createdAt: number;
}

const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function originOf(s: Session, row: Record<string, unknown>): TaskInfo['origin'] {
  const o = rec(rec(s.ext[EXT])['origin'] ?? row['origin'] ?? rec(s.ext['wisp.crew'])['origin']);
  return o['kind'] ? { kind: str(o['kind']), id: str(o['id']) } : null;
}

/** The fields a trigger reads, from the session, its list row (when the event carried it) and its last turn. */
export function taskInfo(s: Session, row: Partial<Summary> = {}, last?: Turn): TaskInfo {
  const r = row as Record<string, unknown>;
  const crew = rec(s.ext['wisp.crew'] ?? r['crew']);
  const wt = rec(s.ext['wisp.worktrees'] ?? r['worktree']);
  const hero = (last?.presentation?.blocks ?? []).find((b) => b?.type === 'hero');
  const hs = rec(hero);
  return {
    id: s.id, title: s.title, cwd: s.cwd, agent: s.agent, ...(s.account && { account: s.account }), state: s.state, archived: s.archived,
    ...(s.parentId && { parentId: s.parentId }),
    helper: !!(r['delegated'] || r['kind'] || r['sideOf'] || rec(s as unknown)['delegated'] || rec(s as unknown)['kind']),
    origin: originOf(s, r),
    crew: crew['id'] ? { id: str(crew['id']), ...(str(crew['job']) && { job: str(crew['job']) }) } : null,
    branch: str(wt['branch']) || str(r['branch']),
    summary: String(hs['summary'] || hs['title'] || '').replace(/\s+/g, ' ').trim() || 'no report',
    createdAt: s.createdAt,
  };
}

/** Reads a task through the runtime: null when it's gone. */
export async function readTask(e: Engine, id: string, row?: Partial<Summary>): Promise<TaskInfo | null> {
  try {
    const s = await e.d.run<Session>(RT.get, { id });
    const turns = await e.d.run<Turn[]>(RT.turns, { id, limit: 1 }).catch(() => [] as Turn[]);
    return taskInfo(s, row, turns.at(-1));
  } catch {
    return null;
  }
}

// Tasks no watcher reacts to: helpers (subagents, wisp's own), a job a task watcher started (two
// of them would start each other for ever), and, when it finishes, a job that isn't one yet.
function skips(e: Engine, kind: string, s: TaskInfo): boolean {
  if (s.parentId || s.helper || s.agent === 'wisp') return true;
  const from = s.origin?.kind === 'trigger' ? e.d.repo.triggers.get(s.origin.id) : undefined;
  return kind === 'finished' && (s.crew?.job === 'event' || (!!from && TASK_KINDS.has(from.kind)));
}

/** The project a member works in, as a folder here ('' = none: it watches every project). */
async function memberProject(e: Engine, id: string): Promise<string> {
  const m = id ? await e.d.member(id) : null;
  if (!m?.cwd || m.machine) return ''; // a member on another machine: its folder isn't one here
  return m.cwd;
}

async function watches(e: Engine, t: Trigger, s: TaskInfo): Promise<boolean> {
  if (t.crew && s.crew?.id === t.crew) return false; // a member's own jobs
  if (s.origin?.kind === 'trigger' && s.origin.id === t.id) return false;
  const dir = t.cwd || (await memberProject(e, t.crew));
  if (!dir) return true;
  return s.cwd === dir || s.cwd.startsWith(dir + path.sep);
}

/** A task finished, or was marked done: the triggers of that kind that watch it fire. */
export async function taskEvent(e: Engine, kind: 'finished' | 'done', s: TaskInfo): Promise<Started[]> {
  if (skips(e, kind, s)) return [];
  const fired: Promise<Started | null>[] = [];
  const vars = { id: s.id, title: s.title || 'Untitled', summary: s.summary, branch: s.branch, cwd: s.cwd };
  for (const t of e.d.repo.list()) {
    if (t.kind !== kind || !t.enabled || e.busy.has(t.id) || !(await watches(e, t, s))) continue;
    const key = `task:${s.id}`;
    if (t.seen.filter((x) => x === key).length >= MAX_PER_TASK) continue;
    t.seen = [key, ...t.seen].slice(0, MAX_SEEN);
    fired.push(e.guard(t, () => e.fire(t, vars, { task: s })));
  }
  return (await Promise.all(fired)).filter((x): x is Started => x !== null);
}

const openTask = (s: TaskInfo | null): s is TaskInfo => !!s && !s.archived && s.state !== 'done' && !s.parentId;

/**
 * The task already on this branch's failures: the one this trigger last sent them to, else the
 * newest task working in that branch's worktree. Not one you archived or marked done: that work is over.
 */
export async function taskFor(e: Engine, t: Trigger, branch: string): Promise<TaskInfo | null> {
  const id = t.tasks?.[branch];
  const linked = id ? await readTask(e, id) : null;
  if (openTask(linked)) return linked;
  const dir = t.cwd || (await memberProject(e, t.crew));
  const rows = await e.d.run<Summary[]>(RT.list, { archived: false }).catch(() => [] as Summary[]);
  let best: Summary | null = null;
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const b = str(row['branch']) || str(rec(row['worktree'])['branch']);
    if (b !== branch || r.archived || r.state === 'done' || r.parentId) continue;
    if (dir && r.cwd !== dir) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best ? readTask(e, best.id, best) : null;
}
