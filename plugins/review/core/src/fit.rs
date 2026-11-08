//! The diff a reviewer reads (v1 judge.js diffSections/splitAt and review.js fitDiff): one section per
//! file, rendered from git.service's parsed `FileDiff`s, then fitted into a budget. A file that doesn't
//! fit is skipped, not the end; an oversized one is cut on hunk boundaries; coverage names what was
//! seen whole, cut, or left out, so a partial review never reads as a pass. Lengths are in chars.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use wisp_git_api::{FileDiff, Row};
use wisp_review_api::Coverage;

/// The diff budget, in chars.
pub const MAX_DIFF: usize = 60_000;
/// Names in `cut` + `missing`: coverage goes on every session summary.
pub const MAX_NAMES: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub path: String,
    pub text: String,
    /// git itself cut it (rows past its cap): never seen whole
    pub cut: bool,
}

/// `text` split before each line starting with `mark` (the first piece is what comes before).
pub fn split_at(text: &str, mark: &str) -> Vec<String> {
    let needle = format!("\n{mark}");
    let mut at = vec![0];
    let mut from = 0;
    while let Some(i) = text[from..].find(&needle) {
        at.push(from + i + 1);
        from += i + 1;
    }
    at.iter()
        .enumerate()
        .map(|(n, &s)| text[s..at.get(n + 1).copied().unwrap_or(text.len())].to_owned())
        .collect()
}

fn unquote(p: &str) -> &str {
    p.strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .unwrap_or(p)
}

/// `a/x` → `x` (and `"a/x"` → `x`): git's optional one-letter prefixes (diff.mnemonicPrefix too).
fn unprefix(p: &str) -> &str {
    let p = unquote(p);
    let b = p.as_bytes();
    if b.len() > 2 && b[0].is_ascii_lowercase() && b[1] == b'/' {
        &p[2..]
    } else {
        p
    }
}

/// The path a section is about: the new name of a rename or copy, else the header's (both halves
/// the same). A path git still quotes keeps its escapes: it won't match `files`, the safe way round.
pub fn section_path(text: &str) -> String {
    for line in text.lines() {
        if let Some(p) = line
            .strip_prefix("rename to ")
            .or_else(|| line.strip_prefix("copy to "))
        {
            return unquote(p).to_owned();
        }
    }
    let first = text.lines().next().unwrap_or("");
    let head = first.strip_prefix("diff --git ").unwrap_or(first);
    for (i, _) in head.match_indices(' ') {
        let (l, r) = (unprefix(&head[..i]), unprefix(&head[i + 1..]));
        if l == r {
            return l.to_owned();
        }
    }
    head.to_owned()
}

fn hunk_text(rows: &[Row], status: char, out: &mut String) {
    let (oc, nc) = rows.iter().fold((0u32, 0u32), |(o, n), r| match r.op {
        '+' => (o, n + 1),
        '-' => (o + 1, n),
        _ => (o + 1, n + 1),
    });
    let ns_seen = rows.iter().find_map(|r| r.b);
    let os_seen = rows.iter().find_map(|r| r.a);
    let ns = if nc == 0 || status == 'D' {
        os_seen.unwrap_or(1).saturating_sub(1)
    } else {
        ns_seen.unwrap_or(1)
    };
    let os = if oc == 0 || status == 'A' {
        if status == 'A' {
            0
        } else {
            ns.saturating_sub(1)
        }
    } else {
        os_seen.unwrap_or(1)
    };
    let _ = writeln!(out, "@@ -{os},{oc} +{ns},{nc} @@");
    for r in rows {
        let _ = writeln!(out, "{}{}", r.op, r.text());
    }
}

/// A file as `git diff` would print it.
pub fn render(f: &FileDiff) -> String {
    let from = f.from.as_deref().unwrap_or(&f.path);
    let mut t = format!("diff --git a/{from} b/{}\n", f.path);
    match f.status {
        'A' => {
            let _ = write!(t, "new file mode 100644\n--- /dev/null\n+++ b/{}\n", f.path);
        }
        'D' => {
            let _ = write!(
                t,
                "deleted file mode 100644\n--- a/{}\n+++ /dev/null\n",
                f.path
            );
        }
        'R' => {
            let _ = write!(
                t,
                "rename from {from}\nrename to {}\n--- a/{from}\n+++ b/{}\n",
                f.path, f.path
            );
        }
        _ => {
            let _ = write!(t, "--- a/{}\n+++ b/{}\n", f.path, f.path);
        }
    }
    if f.binary {
        let _ = writeln!(t, "Binary files a/{from} and b/{} differ", f.path);
        return t;
    }
    let mut hunk: Vec<Row> = Vec::new();
    for r in &f.rows {
        if r.op == '…' {
            if !hunk.is_empty() {
                hunk_text(&hunk, f.status, &mut t);
                hunk.clear();
            }
        } else {
            hunk.push(r.clone());
        }
    }
    if !hunk.is_empty() {
        hunk_text(&hunk, f.status, &mut t);
    }
    t
}

fn no_change(path: &str) -> bool {
    path == "node_modules" || path.starts_with("node_modules/")
}

/// One section per changed file, and every changed path (a linked `node_modules` is no change).
pub fn sections_of(files: &[FileDiff]) -> (Vec<Section>, Vec<String>) {
    let kept: Vec<&FileDiff> = files.iter().filter(|f| !no_change(&f.path)).collect();
    let sections = kept
        .iter()
        .map(|f| Section {
            path: f.path.clone(),
            text: render(f),
            cut: f.more > 0,
        })
        .collect();
    (sections, kept.iter().map(|f| f.path.clone()).collect())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Got {
    Seen,
    Cut,
    Missing,
}

/// Fits `sections` into `max` chars: whole sections first, in order, skipping one that doesn't fit;
/// then what's left cut to the hunks that fit (never a header alone, never half a hunk).
pub fn fit_diff(sections: &[Section], files: &[String], max: usize) -> (String, Coverage) {
    let len = |s: &str| s.chars().count();
    let mut parts: Vec<String> = vec![String::new(); sections.len()];
    let mut got = vec![Got::Missing; sections.len()];
    let mut left = max;
    for (i, s) in sections.iter().enumerate() {
        let n = len(&s.text);
        if n <= left {
            parts[i].clone_from(&s.text);
            got[i] = if s.cut { Got::Cut } else { Got::Seen };
            left -= n;
        }
    }
    for (i, s) in sections.iter().enumerate() {
        if got[i] != Got::Missing {
            continue;
        }
        let pieces = split_at(&s.text, "@@ ");
        let Some((head, hunks)) = pieces.split_first() else {
            continue;
        };
        let Some(mut room) = left.checked_sub(len(head)) else {
            continue;
        };
        let mut kept = String::new();
        for h in hunks {
            let n = len(h);
            if n <= room {
                kept.push_str(h);
                room -= n;
            }
        }
        if kept.is_empty() {
            continue;
        }
        parts[i] = format!("{head}{kept}");
        got[i] = Got::Cut;
        left = room;
    }
    let mut of: HashMap<&str, Vec<Got>> = HashMap::new();
    for (i, s) in sections.iter().enumerate() {
        of.entry(s.path.as_str()).or_default().push(got[i]);
    }
    let mut all: Vec<&str> = Vec::new();
    let mut seen_set = HashSet::new();
    for p in files
        .iter()
        .map(String::as_str)
        .chain(sections.iter().map(|s| s.path.as_str()))
    {
        if seen_set.insert(p) {
            all.push(p);
        }
    }
    let is = |p: &str, g: Got| {
        of.get(p)
            .map_or(g == Got::Missing, |v| v.iter().all(|x| *x == g))
    };
    let seen = all.iter().filter(|p| is(p, Got::Seen)).count();
    let none: Vec<String> = all
        .iter()
        .filter(|p| is(p, Got::Missing))
        .map(|p| (*p).to_owned())
        .collect();
    let cut: Vec<String> = all
        .iter()
        .filter(|p| !is(p, Got::Seen) && !is(p, Got::Missing))
        .map(|p| (*p).to_owned())
        .collect();
    let more = (cut.len() + none.len()).saturating_sub(MAX_NAMES);
    let diff: String = parts.concat();
    let to = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let coverage = Coverage {
        files: to(all.len()),
        seen: to(seen),
        chars: sections.iter().map(|s| len(&s.text) as u64).sum(),
        seen_chars: len(&diff) as u64,
        missing: none
            .into_iter()
            .take(MAX_NAMES.saturating_sub(cut.len()))
            .collect(),
        cut: cut.into_iter().take(MAX_NAMES).collect(),
        more: (more > 0).then(|| to(more)),
    };
    (diff, coverage)
}
