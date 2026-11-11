// The file view's pure parts: the why-gutter from `history.blame`'s lines (a mark where a new task starts, the same
// task's following lines threaded under it), and the status line's words.

/** One line of `history.blame {byLine: true}`. */
export interface BlameLine {
  readonly n: number;
  readonly task?: string | null;
  readonly title?: string | null;
  readonly why?: string | null;
}

export interface Mark {
  readonly task: string;
  readonly label: string;
  readonly title: string;
  readonly first: boolean;
}

/** A mark per line (index 0 is line 1); a line no task wrote (by hand, or not committed yet) has none. */
export function gutterOf(lines: readonly BlameLine[], count: number): (Mark | undefined)[] {
  const out: (Mark | undefined)[] = Array.from({ length: count }, () => undefined);
  let last: string | undefined;
  for (const l of [...lines].sort((a, b) => a.n - b.n)) {
    if (l.n < 1 || l.n > count) continue;
    const task = l.task ?? undefined;
    if (!task) {
      last = undefined;
      continue;
    }
    const label = (l.title ?? '').trim() || task.slice(0, 8);
    const why = (l.why ?? '').trim();
    out[l.n - 1] = { task, label, title: why ? `${label}: ${why.length > 300 ? `${why.slice(0, 300)}…` : why}` : label, first: task !== last };
    last = task;
  }
  return out;
}

/** The status beside the file's name. */
export function statusOf(s: {
  readonly loading: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly error?: string | undefined;
}): 'loading' | 'saving' | 'unsaved' | 'saved' | 'error' {
  if (s.error) return 'error';
  if (s.loading) return 'loading';
  if (s.saving) return 'saving';
  return s.dirty ? 'unsaved' : 'saved';
}
