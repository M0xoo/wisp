// Line diff (LCS) for rendering captured edits as unified hunks (v1 web/js/diff.js).

export interface DiffOp {
  op: ' ' | '+' | '-';
  text: string;
  a?: number;
  b?: number;
}
export type HunkOp = DiffOp | { op: '…'; count: number };

export function diffLines(before = '', after = ''): DiffOp[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  // Trim common prefix/suffix so the LCS table stays small.
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
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: ' ', text: a[i] ?? '', a: i + 1, b: i + 1 });

  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((t, i) => ops.push({ op: '-', text: t, a: start + i + 1 }));
    midB.forEach((t, i) => ops.push({ op: '+', text: t, b: start + i + 1 }));
  } else lcs(midA, midB, start, ops);
  for (let k = 0; k < a.length - endA; k++) ops.push({ op: ' ', text: a[endA + k] ?? '', a: endA + k + 1, b: endB + k + 1 });
  return ops;
}

function lcs(midA: string[], midB: string[], start: number, ops: DiffOp[]): void {
  const n = midA.length;
  const m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const at = (i: number, j: number): number => dp[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    if (!row) continue;
    for (let j = m - 1; j >= 0; j--) row[j] = midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      const text = midA[i] ?? '';
      i++;
      j++;
      ops.push({ op: ' ', text, a: start + i, b: start + j });
    } else if (j < m && (i >= n || at(i, j + 1) > at(i + 1, j))) {
      const text = midB[j] ?? '';
      j++;
      ops.push({ op: '+', text, b: start + j });
    } else {
      const text = midA[i] ?? '';
      i++;
      ops.push({ op: '-', text, a: start + i });
    }
  }
}

// Collapse long unchanged runs, keeping `context` lines around changes.
export function hunks(ops: readonly DiffOp[], context = 3): HunkOp[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: HunkOp[] = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: '…', count: skipped });
      skipped = 0;
      out.push(o);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: '…', count: skipped });
  return out;
}

export function countChanges(edits: readonly { before?: string; after?: string }[] = []): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const e of edits)
    for (const o of diffLines(e.before, e.after)) {
      if (o.op === '+') add++;
      else if (o.op === '-') del++;
    }
  return { add, del };
}
