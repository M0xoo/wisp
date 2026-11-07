//! Test support for property tests: a seeded PRNG (no dependency) and a small unified-diff writer
//! (LCS, 3 lines of context, git's hunk header rules), so parsers are checked against many diffs.
#![allow(clippy::many_single_char_names)]

use std::fmt::Write as _;

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    pub fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % (n.max(1) as u64)).unwrap_or(0)
    }
    /// A random edit of `base`: lines replaced, inserted and removed; never empty.
    pub fn edit(&mut self, base: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        for (i, l) in base.iter().enumerate() {
            match self.below(10) {
                0 => {}
                1 => out.push(format!("x{i}-{}", self.below(1000))),
                2 => {
                    out.push(l.clone());
                    out.push(format!("n{i}-{}", self.below(1000)));
                }
                _ => out.push(l.clone()),
            }
        }
        if out.is_empty() {
            out.push("only".into());
        }
        out
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Keep,
    Del,
    Add,
}

fn script(a: &[String], b: &[String]) -> Vec<Op> {
    let (n, m) = (a.len(), b.len());
    let mut t = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            t[i][j] = if a[i] == b[j] {
                t[i + 1][j + 1] + 1
            } else {
                t[i + 1][j].max(t[i][j + 1])
            };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            out.push(Op::Keep);
            i += 1;
            j += 1;
        } else if j < m && (i == n || t[i][j + 1] >= t[i + 1][j]) {
            out.push(Op::Add);
            j += 1;
        } else {
            out.push(Op::Del);
            i += 1;
        }
    }
    out
}

/// `git diff -U3` of `a` → `b` (both ending in a newline) for file `name`.
pub fn unified(name: &str, a: &[String], b: &[String]) -> String {
    let ops = script(a, b);
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| **o != Op::Keep)
        .map(|(k, _)| k)
        .collect();
    if changed.is_empty() {
        return String::new();
    }
    // group change positions whose context windows touch
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for &k in &changed {
        let lo = k.saturating_sub(3);
        let hi = (k + 3).min(ops.len() - 1);
        match groups.last_mut() {
            Some(g) if lo <= g.1 + 1 => g.1 = hi,
            _ => groups.push((lo, hi)),
        }
    }
    let mut out = format!("diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n");
    let (mut ai, mut bi, mut k) = (0usize, 0usize, 0usize);
    for (lo, hi) in groups {
        while k < lo {
            match ops[k] {
                Op::Keep => (ai, bi) = (ai + 1, bi + 1),
                Op::Del => ai += 1,
                Op::Add => bi += 1,
            }
            k += 1;
        }
        let (mut body, mut oc, mut nc) = (String::new(), 0, 0);
        let (sa, sb) = (ai, bi);
        while k <= hi {
            match ops[k] {
                Op::Keep => {
                    let _ = writeln!(body, " {}", a[ai]);
                    (ai, bi, oc, nc) = (ai + 1, bi + 1, oc + 1, nc + 1);
                }
                Op::Del => {
                    let _ = writeln!(body, "-{}", a[ai]);
                    (ai, oc) = (ai + 1, oc + 1);
                }
                Op::Add => {
                    let _ = writeln!(body, "+{}", b[bi]);
                    (bi, nc) = (bi + 1, nc + 1);
                }
            }
            k += 1;
        }
        let os = if oc == 0 { sa } else { sa + 1 };
        let ns = if nc == 0 { sb } else { sb + 1 };
        let _ = write!(out, "@@ -{os},{oc} +{ns},{nc} @@
{body}");
    }
    out
}
