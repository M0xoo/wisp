//! Reverting part of a task's work from the side panel's Changes (v1 `server/hunks.js`): one hunk of a
//! file's diff, put back as it was at the merge-base. Pure: the route reads and writes the file. Rows are
//! a file's diff rows (git's `-U3` output parsed into [`Row`]s).

use super::diff::{Line, Op, Row};

/// A file's hunk: a run of rows between gaps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// its first line in the file as it is now (1-based), counted even when it has no new-side line
    pub start: usize,
    pub rows: Vec<Line>,
    /// what the file holds now
    pub after: Vec<String>,
    /// what the base had
    pub before: Vec<String>,
}

/// v1's `hunksOf(rows)`.
pub fn hunks_of(rows: &[Row]) -> Vec<Hunk> {
    let mut out: Vec<Hunk> = Vec::new();
    let mut open = false;
    let mut next = 1; // the file's next line after what we've walked
    for r in rows {
        match r {
            Row::Gap(count) => {
                open = false;
                next += count;
            }
            Row::Line(line) => {
                if !open {
                    out.push(Hunk { start: next, rows: Vec::new(), after: Vec::new(), before: Vec::new() });
                    open = true;
                }
                if let Some(h) = out.last_mut() {
                    h.rows.push(line.clone());
                    if line.op != Op::Del {
                        h.after.push(line.text.clone());
                    }
                    if line.op != Op::Add {
                        h.before.push(line.text.clone());
                    }
                }
                if let Some(b) = line.b {
                    next = b + 1;
                }
            }
        }
    }
    out
}

/// v1's `hunkKey(rows)`: the key the page sends for the hunk it showed (djb2 over `op text \n`, by
/// UTF-16 lead unit of each code point, as base 36), so a hunk that moved or changed since is refused.
pub fn hunk_key(rows: &[Line]) -> String {
    let mut h: i32 = 5381;
    let mut add = |c: char| {
        let mut units = [0_u16; 2];
        let unit = c.encode_utf16(&mut units)[0];
        h = (h << 5).wrapping_add(h).wrapping_add(i32::from(unit));
    };
    for r in rows {
        add(r.op.sign());
        r.text.chars().for_each(&mut add);
        add('\n');
    }
    base36(u32::from_ne_bytes(h.to_ne_bytes()))
}

fn base36(mut n: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[usize::try_from(n % 36).unwrap_or(0)]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.iter().rev().map(|&b| char::from(b)).collect()
}

/// v1's `revertHunk(text, rows, i)`: the file with hunk `i` put back, keeping its line endings and its
/// last newline; None when the file's lines there aren't the hunk's any more (edited since the diff was
/// read) or there's no such hunk.
pub fn revert_hunk(text: &str, rows: &[Row], i: usize) -> Option<String> {
    let hunks = hunks_of(rows);
    let h = hunks.get(i)?;
    let nl = text.ends_with('\n');
    let body = if nl { &text[..text.len() - 1] } else { text };
    let mut lines: Vec<&str> = if body.is_empty() && !nl { Vec::new() } else { body.split('\n').collect() };
    let at = h.start.checked_sub(1)?;
    if at + h.after.len() > lines.len() {
        return None;
    }
    if lines[at..at + h.after.len()].iter().zip(&h.after).any(|(l, a)| l != a) {
        return None;
    }
    lines.splice(at..at + h.after.len(), h.before.iter().map(String::as_str));
    if lines.is_empty() {
        return Some(String::new());
    }
    let mut out = lines.join("\n");
    if nl {
        out.push('\n');
    }
    Some(out)
}
