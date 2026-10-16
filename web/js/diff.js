// Line diff (LCS) for rendering captured edits as unified hunks.

export function diffLines(before = '', after = '') {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  // Trim common prefix/suffix so the LCS table stays small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: ' ', text: a[i], a: i + 1, b: i + 1 });

  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((t, i) => ops.push({ op: '-', text: t, a: start + i + 1 }));
    midB.forEach((t, i) => ops.push({ op: '+', text: t, b: start + i + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) ops.push({ op: ' ', text: midA[i], a: start + ++i, b: start + ++j });
      else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) ops.push({ op: '+', text: midB[j], b: start + ++j });
      else ops.push({ op: '-', text: midA[i], a: start + ++i });
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ op: ' ', text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return ops;
}

// Collapse long unchanged runs, keeping `context` lines around changes.
export function hunks(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
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

export function countChanges(edits = []) {
  let add = 0;
  let del = 0;
  for (const e of edits)
    for (const o of diffLines(e.before, e.after)) {
      if (o.op === '+') add++;
      else if (o.op === '-') del++;
    }
  return { add, del };
}
