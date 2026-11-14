//! Line diff (LCS) for rendering captured edits as unified hunks (v1 `web/js/diff.js`).

/// What a diff row does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Op {
    /// `' '`: in both
    Same,
    /// `'+'`
    Add,
    /// `'-'`
    Del,
}

impl Op {
    /// v1's `op` character.
    pub fn sign(self) -> char {
        match self {
            Self::Same => ' ',
            Self::Add => '+',
            Self::Del => '-',
        }
    }
}

/// One line of a diff: `a` is its 1-based line on the old side, `b` on the new.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub op: Op,
    pub text: String,
    pub a: Option<usize>,
    pub b: Option<usize>,
}

/// A row of a shown diff: a line, or a run of unchanged lines left out (v1's `{ op: '…', count }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Line(Line),
    Gap(usize),
}

/// Beyond this many cells the LCS table is skipped: everything old is removed, everything new added.
const MAX_CELLS: usize = 4_000_000;

/// v1's `diffLines(before, after)`.
pub fn diff_lines(before: &str, after: &str) -> Vec<Line> {
    let a: Vec<&str> = if before.is_empty() { Vec::new() } else { before.split('\n').collect() };
    let b: Vec<&str> = if after.is_empty() { Vec::new() } else { after.split('\n').collect() };

    // Trim common prefix/suffix so the LCS table stays small.
    let start = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let line = |op, text: &str, a, b| Line { op, text: text.to_owned(), a, b };
    let mut ops: Vec<Line> = (0..start).map(|i| line(Op::Same, a[i], Some(i + 1), Some(i + 1))).collect();
    let (mid_a, mid_b) = (&a[start..end_a], &b[start..end_b]);
    if mid_a.len().saturating_mul(mid_b.len()) > MAX_CELLS {
        ops.extend(mid_a.iter().enumerate().map(|(i, t)| line(Op::Del, t, Some(start + i + 1), None)));
        ops.extend(mid_b.iter().enumerate().map(|(i, t)| line(Op::Add, t, None, Some(start + i + 1))));
    } else {
        lcs(mid_a, mid_b, start, &mut ops);
    }
    for k in 0..a.len() - end_a {
        ops.push(line(Op::Same, a[end_a + k], Some(end_a + k + 1), Some(end_b + k + 1)));
    }
    ops
}

#[allow(clippy::many_single_char_names)] // the LCS table's usual names (n, m, w, i, j)
fn lcs(mid_a: &[&str], mid_b: &[&str], start: usize, ops: &mut Vec<Line>) {
    let (n, m) = (mid_a.len(), mid_b.len());
    let w = m + 1;
    let mut dp = vec![0_u32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * w + j] = if mid_a[i] == mid_b[j] { dp[(i + 1) * w + j + 1] + 1 } else { dp[(i + 1) * w + j].max(dp[i * w + j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && mid_a[i] == mid_b[j] {
            i += 1;
            j += 1;
            ops.push(Line { op: Op::Same, text: mid_a[i - 1].to_owned(), a: Some(start + i), b: Some(start + j) });
        } else if j < m && (i >= n || dp[i * w + j + 1] > dp[(i + 1) * w + j]) {
            j += 1;
            ops.push(Line { op: Op::Add, text: mid_b[j - 1].to_owned(), a: None, b: Some(start + j) });
        } else {
            i += 1;
            ops.push(Line { op: Op::Del, text: mid_a[i - 1].to_owned(), a: Some(start + i), b: None });
        }
    }
}

/// v1's `hunks(ops, context)`: long unchanged runs collapsed, keeping `context` lines around changes.
pub fn hunks(ops: &[Line], context: usize) -> Vec<Row> {
    let mut keep = vec![false; ops.len()];
    for (i, o) in ops.iter().enumerate() {
        if o.op != Op::Same {
            let hi = (i + context).min(ops.len().saturating_sub(1));
            keep[i.saturating_sub(context)..=hi].fill(true);
        }
    }
    let mut out = Vec::new();
    let mut skipped = 0;
    for (o, &k) in ops.iter().zip(&keep) {
        if k {
            if skipped > 0 {
                out.push(Row::Gap(skipped));
            }
            skipped = 0;
            out.push(Row::Line(o.clone()));
        } else {
            skipped += 1;
        }
    }
    if skipped > 0 && !out.is_empty() {
        out.push(Row::Gap(skipped));
    }
    out
}

/// v1's `countChanges(edits)`: (lines added, lines removed) over (before, after) pairs.
pub fn count_changes<'a>(edits: impl IntoIterator<Item = (&'a str, &'a str)>) -> (usize, usize) {
    let (mut add, mut del) = (0, 0);
    for (before, after) in edits {
        for o in diff_lines(before, after) {
            match o.op {
                Op::Add => add += 1,
                Op::Del => del += 1,
                Op::Same => {}
            }
        }
    }
    (add, del)
}
