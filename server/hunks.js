// Reverting part of a task's work from the side panel's Changes (design/side-panel.md): one hunk
// of a file's diff, put back as it was at the merge-base. Pure: the route reads and writes the file.
// rows are a file's from git.js parseDiff: { op: ' ' | '+' | '-', text, a, b } and { op: '…', count }.

// A file's hunks: the runs of rows between '…' gaps. start is the hunk's first line in the file as
// it is now (1-based), counted even when the hunk has no new-side line (all of it removed).
export function hunksOf(rows = []) {
  const out = [];
  let h = null;
  let next = 1; // the file's next line after what we've walked
  for (const r of rows) {
    if (r.op === '…') {
      h = null;
      next += r.count || 0;
      continue;
    }
    if (r.op !== ' ' && r.op !== '+' && r.op !== '-') continue;
    if (!h) out.push((h = { start: next, rows: [] }));
    h.rows.push(r);
    if (r.b != null) next = r.b + 1;
  }
  return out.map((x) => ({
    ...x,
    after: x.rows.filter((r) => r.op !== '-').map((r) => r.text), // what the file holds now
    before: x.rows.filter((r) => r.op !== '+').map((r) => r.text), // what the base had
  }));
}

// The key the page sends for the hunk it showed (the same sum as changes.js hash()), so a hunk that
// moved or changed since is refused rather than reverting the one now at that index.
export function hunkKey(rows = []) {
  let h = 5381;
  for (const r of rows) for (const c of `${r.op}${r.text ?? r.count}\n`) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

// A text's lines and how it ends, so a revert keeps its line endings and its last newline.
function linesOf(text) {
  const nl = text.endsWith('\n');
  const body = nl ? text.slice(0, -1) : text;
  return { lines: body === '' && !nl ? [] : body.split('\n'), nl };
}

// The file with hunk i of its diff put back, or null when the file's lines there aren't the hunk's
// any more (edited since the diff was read) or there's no such hunk.
export function revertHunk(text, rows, i) {
  const h = hunksOf(rows)[i];
  if (!h || typeof text !== 'string') return null;
  const { lines, nl } = linesOf(text);
  const at = h.start - 1;
  if (at < 0 || at + h.after.length > lines.length) return null;
  for (let k = 0; k < h.after.length; k++) if (lines[at + k] !== h.after[k]) return null;
  lines.splice(at, h.after.length, ...h.before);
  return lines.length ? lines.join('\n') + (nl ? '\n' : '') : '';
}
