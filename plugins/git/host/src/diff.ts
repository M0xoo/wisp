// `git diff` output, one entry per file, parsed as it streams in: a 1,000-file diff is read in the
// chunks the pipe delivers, so no single piece of work holds the event loop (v1 buffered all of it,
// then parsed it in one go). rows are the hunks as the page draws them.

import type { DiffFile, DiffRow } from '@wisp-plugin/git-api';

export const DIFF_LINES = 2000; // a file's rows past this are counted, not sent

export class DiffParser {
  readonly files: DiffFile[] = [];
  #f: DiffFile | null = null;
  #a = 0;
  #b = 0;
  #rest = '';

  /** Feed a chunk; whole lines are parsed now, a partial last line waits for the next chunk. */
  push(chunk: string): void {
    const text = this.#rest + chunk;
    const end = text.lastIndexOf('\n');
    if (end < 0) {
      this.#rest = text;
      return;
    }
    this.#rest = text.slice(end + 1);
    let from = 0;
    while (from <= end) {
      const nl = text.indexOf('\n', from);
      this.#line(text.slice(from, nl));
      from = nl + 1;
    }
  }

  end(): DiffFile[] {
    if (this.#rest) this.#line(this.#rest);
    this.#rest = '';
    return this.files;
  }

  #row(row: DiffRow): void {
    const f = this.#f;
    if (!f) return;
    if (f.rows.length < DIFF_LINES) f.rows.push(row);
    else f.more++;
  }

  #line(line: string): void {
    if (line.startsWith('diff --git ')) {
      const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (head?.[2] !== undefined) {
        this.#f = { path: head[2], status: 'M', add: 0, del: 0, binary: false, rows: [], more: 0 };
        this.files.push(this.#f);
        this.#a = this.#b = 1; // the next line of the old file and the new one
        return;
      }
    }
    const f = this.#f;
    if (!f) return;
    const c = line[0];
    if (c === '+' && !line.startsWith('+++')) {
      f.add++;
      this.#row({ op: '+', text: line.slice(1), b: this.#b++ });
    } else if (c === '-' && !line.startsWith('---')) {
      f.del++;
      this.#row({ op: '-', text: line.slice(1), a: this.#a++ });
    } else if (c === ' ') this.#row({ op: ' ', text: line.slice(1), a: this.#a++, b: this.#b++ });
    else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      const gap = Number(m?.[2] ?? 1) - this.#b;
      if (gap > 0) this.#row({ op: '…', count: gap });
      this.#a = Number(m?.[1] ?? 1);
      this.#b = Number(m?.[2] ?? 1);
    } else this.#meta(f, line);
  }

  #meta(f: DiffFile, line: string): void {
    if (line.startsWith('new file mode')) f.status = 'A';
    else if (line.startsWith('deleted file mode')) f.status = 'D';
    else if (line.startsWith('rename from ')) {
      f.from = line.slice(12);
      f.status = 'R';
    } else if (line.startsWith('rename to ')) f.path = line.slice(10);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') f.binary = true;
  }
}

/** The whole output at once (tests, small diffs). */
export function parseDiff(out: string): DiffFile[] {
  const p = new DiffParser();
  p.push(out);
  return p.end();
}

/**
 * text in pieces, each starting at a line that begins with `mark`; what comes before the first is
 * the first piece. Not a /^/m regex: that also matches after a bare \r inside a line of code.
 */
export function splitAt(text: string, mark: string): string[] {
  const at = [0];
  for (let i = text.indexOf(`\n${mark}`); i !== -1; i = text.indexOf(`\n${mark}`, i + 1)) at.push(i + 1);
  return at.map((from, n) => text.slice(from, at[n + 1]));
}

const unquote = (p: string): string => p.replace(/^"(.*)"$/, '$1');

/**
 * The path a section of `git diff` is about: the new name of a rename or copy, else its header. The
 * prefixes are optional for diff.noprefix and diff.mnemonicPrefix. A path git still quotes keeps its
 * escapes: it won't match `files`, so it reads as not reviewed, the safe way round.
 */
export function sectionPath(text: string): string {
  const to = /(?:^|\n)(?:rename|copy) to (.+)/.exec(text);
  if (to?.[1]) return unquote(to[1]);
  const m = /^diff --git "?(?:[a-z]\/)?(.*?)"? "?(?:[a-z]\/)?\1"?(?:\n|$)/.exec(text);
  return m?.[1] ?? (text.split('\n')[0] ?? '').replace(/^diff --git /, '');
}
