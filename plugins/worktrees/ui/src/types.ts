// The shapes the Worktrees pane reads, from v1's GET /worktrees (server/services/worktrees.js view())
// and GET /projects/:id/foreign-worktrees (server/services/bring-in.js), until Rust generates them.
// One file, so switching to generated types is one edit.

import type { PeerId } from '@wisp/client';
import type { Topic } from '@wisp/protocol';

/** Everything this pane reads rides on one topic of the home peer. */
export const TOPIC: Topic = 'plugin:wisp.worktrees:worktrees';

export const KIND = {
  /** a task with at least one folder on disk, keyed by the task's id */
  item: 'worktrees.item',
  /** a folder in worktrees/ no task knows, keyed by its folder name */
  leftover: 'worktrees.leftover',
  /** one row, id `status`: totals, the disk, the last and the running clean-up */
  status: 'worktrees.status',
  /** worktrees another tool left in a project, keyed by the project's id (Bring in) */
  offer: 'worktrees.offer',
} as const;

export const STATUS_ID = 'status';

/** Why a task's folder stays, or `idle`: it can go (v1 standing()). */
export type ItemStatus = 'idle' | 'dirty' | 'busy' | 'kept' | 'parked' | 'pr' | 'unreadable' | 'checking';

/** A `worktrees.item` row: the server's columns (snake case where two words). */
export interface WorktreeItem {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly branch: string;
  readonly status: ItemStatus;
  /** files only this folder holds (uncommitted) */
  readonly only: number;
  /** bytes; null where there's no du */
  readonly size: number | null;
  readonly used_at: number;
  /** when the cleanup takes it (idle only) */
  readonly clean_at: number | null;
}

export interface Leftover {
  readonly name: string;
  readonly size: number | null;
  /** null: git can't tell */
  readonly only: number | null;
  readonly used_at: number;
}

export interface WorktreesStatus {
  readonly size: number | null;
  readonly disk: { readonly free: number; readonly total: number } | null;
  /** the first scan (sizes, git status) hasn't answered yet */
  readonly looking: boolean;
  readonly cleaning: { readonly done: number; readonly total: number } | null;
  readonly last: { readonly at: number; readonly count: number; readonly freed: number } | null;
}

export interface OfferItem {
  readonly path: string;
  readonly branch: string;
  readonly name: string;
  /** uncommitted files */
  readonly dirty: number;
  /** a Claude Code chat to resume in it */
  readonly chat: boolean;
}

export interface Offer {
  /** the project's id */
  readonly project: string;
  /** the project's name, for the row */
  readonly name: string;
  /** the tool that left them: "Conductor" */
  readonly from: string;
  readonly items: readonly OfferItem[];
  /** worktrees with no branch: they can't be brought in */
  readonly detached: number;
}

/** One row of the list: a task's folders or a leftover, as v1's entries() built them. */
export type Entry =
  | (WorktreeItem & { readonly key: string; readonly left: false })
  | { readonly key: string; readonly left: true; readonly name: string; readonly title: string; readonly status: 'dirty' | 'left'; readonly only: number | null; readonly size: number | null; readonly used_at: number };

export type Filter = 'all' | 'dirty' | 'kept' | 'left';

// ---------- settings (v1 defaults.*, as the manifest declares them: settings-api key_of) ----------

export const SETTING = {
  cleanup: 'worktrees.cleanup',
  max: 'worktrees.max',
  onDone: 'worktrees.onDone',
} as const;

export const CLEANUP_CHOICES = ['off', '3', '7', '14', '30'] as const;
export const CLEANUP_DEFAULT = '7';
export const MAX_CHOICES = ['off', '20', '40', '80'] as const;
export const MAX_DEFAULT = '40';
export const ON_DONE_CHOICES = ['ask', 'remove', 'keep'] as const;
export const ON_DONE_DEFAULT = 'ask';

// ---------- command arguments ----------

/** worktrees.clean (v1 POST /worktrees/clean): ids, leftovers by folder name, force for uncommitted work. */
export interface CleanArgs {
  readonly peer: PeerId;
  readonly ids?: readonly string[];
  readonly leftovers?: readonly string[];
  readonly force?: boolean;
}

/** worktrees.keep (v1 PATCH /sessions/:id { keepWorktree }). */
export interface KeepArgs {
  readonly peer: PeerId;
  readonly id: string;
  readonly keep: boolean;
}

/** worktrees.bringIn (v1 POST /projects/:id/foreign-worktrees { paths }). */
export interface BringInArgs {
  readonly peer: PeerId;
  readonly project: string;
  readonly paths: readonly string[];
}

/** worktrees.dismiss (v1 POST /projects/:id/foreign-worktrees/dismiss): Not now. */
export interface DismissArgs {
  readonly peer: PeerId;
  readonly project: string;
}

// ---------- Done's folders (worktrees.done.list / apply: api FolderRow, DoneList, DoneApplyOut) ----------

export type OnDone = 'ask' | 'remove' | 'keep';

/** One folder a task marked done (or what ran under it) holds on disk. */
export interface DoneFolder {
  readonly path: string;
  /** the task holding it */
  readonly task: string;
  readonly title: string;
  /** the task marked done itself */
  readonly own: boolean;
  readonly branch: string;
  /** bytes; null until the second answer, or where there's no du */
  readonly size: number | null;
  /** what's lost with it: uncommitted paths, plus one when HEAD left the branch; null: git can't tell */
  readonly only: number | null;
  readonly uncommitted: number | null;
  readonly unpushed: number;
  readonly pr: { readonly number: number; readonly url: string; readonly state: string } | null;
  readonly kept: boolean;
}

export interface DoneList {
  readonly folders: readonly DoneFolder[];
  readonly onDone: OnDone;
}

export interface DoneApplyOut {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly { readonly path: string; readonly error: string }[];
}

/** worktrees.done.apply: the paths to remove (`force`: the ones holding work you ticked), the ones to keep. */
export interface DoneApplyArgs {
  readonly peer: PeerId;
  readonly sessionId: string;
  readonly remove?: readonly string[];
  readonly force?: readonly string[];
  readonly keep?: readonly string[];
  /** local only: the tasks whose folders Keep pins (their rows read Kept at once) */
  readonly keepTasks?: readonly string[];
}
