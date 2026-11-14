// The session row fields Home reads (the runtime plugin's `session` entity, v1's summary shape):
// the state words, what it asks, its crew member, its goal, and its overlaps with other tasks.

/** The entity kind of a task's summary row. */
export const SESSION = 'session';

/** Another open task in the same repo touching the same files (v1 overlaps.js). */
export interface Overlap {
  /** the other task's id */
  readonly id: string;
  readonly files: readonly string[];
  /** how many more files beyond `files` */
  readonly more?: number;
  /** merging both: undefined when not checked, [] when clean, else the files that clash */
  readonly conflicts?: readonly string[];
}

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly project?: string;
  readonly state: 'running' | 'review' | 'done' | 'error' | 'idle';
  readonly status?: string;
  readonly updatedAt: number;
  readonly archived?: boolean;
  readonly forLater?: boolean;
  /** set by the server when it decides the task waits on you */
  readonly needs?: boolean;
  readonly question?: string;
  readonly approval?: boolean;
  readonly reminder?: boolean;
  /** the last thing it said */
  readonly preview?: string;
  /** the runs of one task started in several places share a group */
  readonly groupId?: string;
  readonly crew?: { readonly id?: string; readonly name?: string };
  readonly goal?: { readonly status: string; readonly round?: number; readonly last?: { readonly why?: string } };
  readonly overlaps?: readonly Overlap[];
}
