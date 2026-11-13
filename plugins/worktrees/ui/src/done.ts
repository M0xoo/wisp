// Done asks about the worktree (design/worktrees-on-done.md, v1 web/js/features/done-folders.js), as pure
// functions: which tasks this client just marked done, what the setting does with the folders, and what
// each row and the dialog say. The server decides what's safe (wisp-worktrees-core `done`); this decides
// what to ask.

import type { EntityKey, PendingInfo } from '@wisp/client';
import type { Key, Vars } from './i18n.ts';
import type { DoneApplyOut, DoneFolder, OnDone } from './types.ts';

/** runtime's list row kind: Mark done patches its `/state` */
export const SESSION = 'session';

/**
 * The tasks a command of this client just marked done: a pending op (the optimistic patch of
 * `runtime.setState`, from the task page, its row, the list or a shortcut) that sets a session's state to
 * `done`, from a command not seen before. Done from a channel, the phone's notification or an agent is
 * another client's (or none): it never shows here, so it never asks (v1: no dialog from anywhere else).
 */
export function newlyDone(pending: readonly PendingInfo[], seen: Set<string>): EntityKey[] {
  const out: EntityKey[] = [];
  for (const p of pending) {
    if (seen.has(p.mid)) continue;
    seen.add(p.mid);
    for (const op of p.ops) {
      if (op.e !== SESSION || op.op !== 'patch') continue;
      if (op.ops.some((x) => x.op === 'replace' && x.path === '/state' && x.value === 'done') && !out.includes(op.id)) out.push(op.id);
    }
  }
  return out;
}

/** What only the folder holds goes with it; null (git can't tell) counts as holding work. */
export const holdsWork = (f: DoneFolder): boolean => f.only !== 0;

export interface Plan {
  /** pinned with no question */
  readonly keep: readonly string[];
  /** removed with no question */
  readonly remove: readonly string[];
  /** the rows to ask about, or none */
  readonly ask: readonly DoneFolder[];
  /** `remove` took the clean ones: the dialog asks only about these, which hold work */
  readonly only: boolean;
}

/** The setting's answer (v1 askAboutFolders): ask shows every row; remove takes the clean ones and asks about
 *  the rest; keep pins every one. Nothing on disk: nothing at all. */
export function planDone(setting: OnDone, folders: readonly DoneFolder[]): Plan {
  if (folders.length === 0) return { keep: [], remove: [], ask: [], only: false };
  if (setting === 'keep') return { keep: folders.map((f) => f.path), remove: [], ask: [], only: false };
  if (setting === 'remove') {
    const left = folders.filter(holdsWork);
    return { keep: [], remove: folders.filter((f) => !holdsWork(f)).map((f) => f.path), ask: left, only: left.length > 0 };
  }
  return { keep: [], remove: [], ask: folders, only: false };
}

export interface Said {
  readonly key: Key;
  readonly vars?: Vars;
}

/** The state column, first that applies: what the user weighs before removing it. */
export function stateOf(f: DoneFolder): Said & { readonly warn: boolean } {
  if (f.only === null) return { key: 'worktrees.folders.state.unreadable', warn: true };
  if (f.only > 0) return (f.uncommitted ?? 0) > 0 ? { key: 'worktrees.folders.state.uncommitted', vars: { count: f.uncommitted ?? 0 }, warn: true } : { key: 'worktrees.folders.state.off-branch', warn: true };
  if (f.pr?.state === 'OPEN') return { key: 'worktrees.folders.state.pr-open', vars: { n: f.pr.number }, warn: false };
  if (f.pr?.state === 'MERGED') return { key: 'worktrees.folders.state.pr-merged', vars: { n: f.pr.number }, warn: false };
  if (f.unpushed > 0) return { key: 'worktrees.folders.state.unpushed', vars: { count: f.unpushed }, warn: false };
  return { key: 'worktrees.folders.state.clean', warn: false };
}

/** What ticking a row holding work loses, said under its name; none for a clean one. */
export function losesOf(f: DoneFolder): Said | undefined {
  if (!holdsWork(f)) return undefined;
  if (f.only === null) return { key: 'worktrees.folders.loses.unreadable' };
  return (f.uncommitted ?? 0) > 0 ? { key: 'worktrees.folders.loses.uncommitted', vars: { count: f.uncommitted ?? 0 } } : { key: 'worktrees.folders.loses.off-branch' };
}

/** Clean rows start ticked; one holding work only when you tick it. */
export const initiallyTicked = (folders: readonly DoneFolder[]): string[] => folders.filter((f) => !holdsWork(f)).map((f) => f.path);

/** The dialog's title and the line under it. */
export function heading(folders: readonly DoneFolder[], only: boolean): { title: Said; hint: Said } {
  const n = folders.length;
  if (only) return { title: { key: 'worktrees.folders.holds', vars: { count: n } }, hint: { key: 'worktrees.folders.holds.hint' } };
  const dirty = folders.filter(holdsWork).length;
  return { title: { key: 'worktrees.folders.ask', vars: { count: n } }, hint: dirty ? { key: 'worktrees.folders.hint.dirty', vars: { count: dirty } } : { key: 'worktrees.folders.hint' } };
}

/** The Remove button: its label for the ticked count, and red once a ticked row holds work. */
export function removeButton(folders: readonly DoneFolder[], ticked: readonly string[]): { label: Said; danger: boolean; disabled: boolean } {
  const n = ticked.length;
  const danger = folders.some((f) => holdsWork(f) && ticked.includes(f.path));
  return { label: n > 1 ? { key: 'worktrees.folders.remove.n', vars: { n } } : { key: 'worktrees.folders.remove' }, danger, disabled: n === 0 };
}

/** What Remove sends: the ticked paths, and of those the ones holding work as `force`. */
export function removal(folders: readonly DoneFolder[], ticked: readonly string[]): { remove: string[]; force: string[] } {
  const remove = folders.filter((f) => ticked.includes(f.path)).map((f) => f.path);
  return { remove, force: folders.filter((f) => holdsWork(f) && remove.includes(f.path)).map((f) => f.path) };
}

/** The toast after an answer: what went (and how much), or what was kept and why. None when there's nothing to say. */
export function outcome(out: DoneApplyOut, folders: readonly DoneFolder[]): { tone: 'success' | 'error'; said: Said; bytes: number } | undefined {
  const one = out.failed[0];
  if (one) {
    const f = folders.find((x) => x.path === one.path);
    return out.failed.length === 1
      ? { tone: 'error', said: { key: 'worktrees.folders.failed.one', vars: { name: f ? f.title || f.branch : one.path, error: one.error } }, bytes: 0 }
      : { tone: 'error', said: { key: 'worktrees.folders.failed.n', vars: { count: out.failed.length, error: one.error } }, bytes: 0 };
  }
  if (out.removed.length === 0) return undefined;
  const bytes = folders.filter((f) => out.removed.includes(f.path)).reduce((n, f) => n + (f.size ?? 0), 0);
  return { tone: 'success', said: { key: bytes ? 'worktrees.folders.removed.size' : 'worktrees.folders.removed', vars: { count: out.removed.length } }, bytes };
}

/** Sizes from the second answer onto the rows, by path (a row it doesn't name keeps what it had). */
export function withSizes(folders: readonly DoneFolder[], sized: readonly DoneFolder[]): DoneFolder[] {
  return folders.map((f) => {
    const s = sized.find((x) => x.path === f.path);
    return s ? { ...f, size: s.size } : f;
  });
}
