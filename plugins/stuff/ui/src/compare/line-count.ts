// Lines a captured edit added and took out (v1 web/js/diff.js countChanges over diffLines): an LCS of
// the lines between the common head and tail, so a one-line change in a long file costs nothing.

/** The lines an edit added and removed. */
function countEdit(before: string, after: string): { add: number; del: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // Past this the table is too big to build: count it as all-out, all-in, as v1 does.
  if (midA.length * midB.length > 4_000_000) return { add: midB.length, del: midA.length };
  const common = lcs(midA, midB);
  return { add: midB.length - common, del: midA.length - common };
}

function lcs(a: readonly string[], b: readonly string[]): number {
  let next = new Uint32Array(b.length + 1);
  for (let i = a.length - 1; i >= 0; i--) {
    const row = new Uint32Array(b.length + 1);
    for (let j = b.length - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    next = row;
  }
  return next[0] ?? 0;
}

export function countChanges(edits: readonly { readonly before?: string; readonly after?: string }[] = []): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const e of edits) {
    const c = countEdit(e.before ?? '', e.after ?? '');
    add += c.add;
    del += c.del;
  }
  return { add, del };
}
