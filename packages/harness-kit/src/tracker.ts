// For harnesses that only report "file X changed" after the fact (v1 adapters/common.js
// fileTracker), async: git runs through the proc service and files are read with fs/promises.
//
// The "before" side comes from, in order: the content after the previous change we saw, else a
// snapshot taken when the harness announced the edit (only if it predates the write — the harness
// doesn't wait for us), else the file as it was when the turn started — `git stash create` captures
// tracked working-tree changes without touching anything — else nothing (treated as a new file).

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProcService } from '@wisp/kernel';
import { MAX_SNAPSHOT, rel, type RunPaths } from './paths.ts';

export interface TrackedChange {
  file: string;
  op: 'create' | 'write';
  beforeFile: string | null;
  edits: { before: string; after: string }[];
}

export interface FileTracker {
  /** the harness announced an edit to `file`: keep what it holds now, in case it predates the write */
  remember(file: string): Promise<void>;
  /** call after the harness wrote `file`: a `change` payload, or null if it didn't change */
  change(file: string): Promise<TrackedChange | null>;
}

/** The file now: null when it isn't one, '' when it is over MAX_SNAPSHOT (v1 readSnapshot). */
export async function readSnapshot(abs: string): Promise<string | null> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    return st.size <= MAX_SNAPSHOT ? await readFile(abs, 'utf8') : '';
  } catch {
    return null;
  }
}

/** The file when it is at most `max` bytes, else null (missing, not a file, too big). */
export async function readUpTo(abs: string, max: number): Promise<string | null> {
  try {
    const st = await stat(abs);
    return st.isFile() && st.size <= max ? await readFile(abs, 'utf8') : null;
  } catch {
    return null;
  }
}

interface Pin {
  base: string | null;
  /** rel path → its content at base, read once per pin */
  shown: Map<string, Promise<string | null>>;
}

// A folder pinned for this tick, and the files read from that pin since. A delegate call starts all
// its subagents in one tick, in one folder: each pinning it for itself would run git once per
// subagent, and they'd all get the same answer.
const pins = new Map<string, Promise<Pin>>();

async function git(proc: ProcService, cwd: string, args: string[], maxBuffer?: number): Promise<string | null> {
  try {
    const r = await proc.exec('git', args, { cwd, ...(maxBuffer !== undefined && { maxBuffer }) });
    return r.code === 0 && !r.timedOut ? r.stdout : null;
  } catch {
    return null;
  }
}

function pinFolder(proc: ProcService, cwd: string): Promise<Pin> {
  const had = pins.get(cwd);
  if (had) return had;
  const pin = (async (): Promise<Pin> => {
    const stash = (await git(proc, cwd, ['stash', 'create']))?.trim();
    const base = stash || (await git(proc, cwd, ['rev-parse', '--verify', 'HEAD']))?.trim() || null;
    return { base, shown: new Map() };
  })();
  pins.set(cwd, pin);
  // Kept for this tick and the git calls it started: a later turn pins afresh.
  void pin.finally(() => setImmediate(() => pins.get(cwd) === pin && pins.delete(cwd)));
  return pin;
}

/**
 * A tracker for one run. `pinned: false` makes one with no git base (a harness that reports its
 * edits itself never needs it); pinning runs before the CLI starts writing.
 */
export async function fileTracker(proc: ProcService, paths: RunPaths, pinned = true): Promise<FileTracker> {
  const { cwd } = paths;
  const { base, shown } = pinned ? await pinFolder(proc, cwd) : { base: null, shown: new Map<string, Promise<string | null>>() };
  const known = new Map<string, string | null>(); // rel path -> content after our last change()
  const announced = new Map<string, string | null>(); // rel path -> content when the harness announced an edit
  const fromGit = (r: string): Promise<string | null> => {
    if (!base || path.isAbsolute(r)) return Promise.resolve(null);
    const had = shown.get(r);
    if (had) return had;
    // git wants / even on Windows
    const read = git(proc, cwd, ['show', `${base}:./${r.split(path.sep).join('/')}`], 8 * MAX_SNAPSHOT).then((out) => (out === null ? null : Buffer.byteLength(out) <= MAX_SNAPSHOT ? out : ''));
    shown.set(r, read);
    return read;
  };
  return {
    async remember(file) {
      const r = rel(file, paths);
      // The driver runs IO steps one at a time, so nothing else touches the maps during the read.
      if (!known.has(r) && !announced.has(r)) announced.set(r, await readSnapshot(path.resolve(cwd, file)));
    },
    async change(file) {
      const r = rel(file, paths);
      const after = await readSnapshot(path.resolve(cwd, file));
      let before: string | null;
      const was = announced.get(r);
      if (known.has(r)) before = known.get(r) ?? null;
      // An empty snapshot may be the write caught half way (truncated, not written yet): ask git.
      else if (was !== undefined && was !== after && was !== '') before = was;
      else before = await fromGit(r);
      known.set(r, after);
      announced.delete(r);
      if (before === after) return null;
      return { file: r, op: before === null ? 'create' : 'write', beforeFile: before, edits: [{ before: before ?? '', after: after ?? '' }] };
    },
  };
}
