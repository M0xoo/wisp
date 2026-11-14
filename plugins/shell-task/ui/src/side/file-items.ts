// Open file…'s palette rows (v1 editor.js openFileFinder, grepIn), pure: the task's files by name, the changed ones
// first; then where the words typed are inside them.
import type { PaletteItem } from '@wisp/shell/contract';

/** One place `worktrees.grep {q}` found the words. */
export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** `src/a.ts` (+ `#L12`) → the file view beside `task`. */
export type OpenAt = (path: string, line?: number) => void;

/** Each file a row: its name, its folder after it; the task's changed ones first, under their own heading (v1). */
export function fileItems(files: readonly string[], changed: ReadonlySet<string>, open: OpenAt): PaletteItem[] {
  const rows = files.map((f) => {
    const i = f.lastIndexOf('/');
    const mine = changed.has(f);
    return {
      id: `file:${f}`,
      group: mine ? 'shell-task.files.changed' : 'shell-task.files.all',
      label: f.slice(i + 1),
      ...(i > 0 && { sub: f.slice(0, i) }),
      icon: 'file',
      keywords: f,
      run: () => open(f),
      mine,
    };
  });
  // changed files lead, as in Changes (a stable sort keeps git's order inside each)
  return rows.sort((a, b) => Number(b.mine) - Number(a.mine)).map(({ mine: _, ...r }) => r);
}

/** A text hit a row: `name:line`, the line's words after it; it opens the file at that line. */
export function hitItems(hits: readonly Hit[], open: OpenAt): PaletteItem[] {
  return hits.map((h) => ({
    id: `hit:${h.path}:${h.line}`,
    group: 'shell-task.files.inFiles',
    label: `${h.path.split('/').pop() ?? h.path}:${h.line}`,
    sub: h.text,
    icon: 'search',
    keywords: h.path,
    run: () => open(h.path, h.line),
  }));
}

