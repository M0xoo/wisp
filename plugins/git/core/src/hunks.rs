//! Reverting part of a task's work from Changes (v1 server/hunks.js): a file's rows split into hunks,
//! one put back as it was at the merge-base, and the key the page sends so a hunk that moved or changed
//! since it was shown is refused (edge case Git 10) rather than reverting whatever is now at that index.

use wisp_git_api::Row;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// its first line in the file as it is now (1-based), even with no new-side line left
    pub start: u32,
    pub rows: Vec<Row>,
    /// what the file holds now
    pub after: Vec<String>,
    /// what the base had
    pub before: Vec<String>,
}

/// A file's hunks: the runs of rows between '…' gaps.
pub fn hunks_of(rows: &[Row]) -> Vec<Hunk> {
    let mut out: Vec<Hunk> = Vec::new();
    let mut open = false;
    let mut next: u32 = 1;
    for r in rows {
        if r.op == '…' {
            open = false;
            next += r.count.unwrap_or(0);
            continue;
        }
        if !matches!(r.op, ' ' | '+' | '-') {
            continue;
        }
        if !open {
            out.push(Hunk { start: next, rows: Vec::new(), after: Vec::new(), before: Vec::new() });
            open = true;
        }
        if let Some(h) = out.last_mut() {
            h.rows.push(r.clone());
            if r.op != '-' {
                h.after.push(r.text().to_owned());
            }
            if r.op != '+' {
                h.before.push(r.text().to_owned());
            }
        }
        if let Some(b) = r.b {
            next = b + 1;
        }
    }
    out
}

/// djb2 over `op + (text ?? count) + "\n"` per row, as UTF-16 code units the way the page's JS
/// computes it (`charCodeAt(0)` of each code point: the high surrogate for astral ones), base 36.
pub fn hunk_key(rows: &[Row]) -> String {
    let mut h: i32 = 5381;
    let mut feed = |s: &str| {
        for c in s.chars() {
            let cp = c as u32;
            let unit = if cp > 0xFFFF { 0xD800 + ((cp - 0x1_0000) >> 10) } else { cp };
            #[allow(clippy::cast_possible_wrap)]
            let unit = unit as i32;
            h = (h << 5).wrapping_add(h).wrapping_add(unit);
        }
    };
    for r in rows {
        let mut buf = [0u8; 4];
        feed(r.op.encode_utf8(&mut buf));
        match (&r.text, r.count) {
            (Some(t), _) => feed(t),
            (None, Some(n)) => feed(&n.to_string()),
            (None, None) => feed("undefined"),
        }
        feed("\n");
    }
    #[allow(clippy::cast_sign_loss)]
    base36(h as u32)
}

fn base36(mut n: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

/// The file with hunk `i` put back, or None when the file's lines there aren't the hunk's any more
/// (edited since the diff was read) or there is no such hunk. Keeps the last newline as it was.
pub fn revert_hunk(text: &str, rows: &[Row], i: usize) -> Option<String> {
    let h = hunks_of(rows).into_iter().nth(i)?;
    let nl = text.ends_with('\n');
    let body = if nl { &text[..text.len() - 1] } else { text };
    let mut lines: Vec<&str> = if body.is_empty() && !nl { Vec::new() } else { body.split('\n').collect() };
    let at = usize::try_from(h.start.checked_sub(1)?).ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_diff;
    use crate::testrng::Rng;

    const DIFF: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n@@ -15,6 +15,7 @@\n l15\n l16\n l17\n-l18\n+L18\n l19\n l20\n+l21\n";

    fn base() -> Vec<String> {
        (1..=20).map(|i| format!("l{i}")).collect()
    }
    fn now() -> String {
        let mut v = base();
        v[1] = "L2".into();
        v[17] = "L18".into();
        v.push("l21".into());
        format!("{}\n", v.join("\n"))
    }
    fn rows() -> Vec<Row> {
        parse_diff(DIFF).remove(0).rows
    }

    #[test]
    fn hunks_between_gaps_with_both_sides() {
        let hs = hunks_of(&rows());
        assert_eq!(hs.len(), 2);
        assert_eq!((hs[0].start, hs[1].start), (1, 15));
        assert_eq!(hs[0].after, ["l1", "L2", "l3", "l4", "l5"]);
        assert_eq!(hs[0].before, ["l1", "l2", "l3", "l4", "l5"]);
        assert_eq!(hs[1].after, ["l15", "l16", "l17", "L18", "l19", "l20", "l21"]);
        assert_eq!(hunks_of(&[]), Vec::new());
        let cut = hunks_of(&[Row::gap(4), Row::removed("x", 5)]);
        assert_eq!(cut[0].start, 5, "a hunk with nothing on the new side still knows where it goes");
    }

    #[test]
    fn revert_one_keeps_the_rest_and_the_newline() {
        let text = now();
        let second = revert_hunk(&text, &rows(), 1).unwrap_or_default();
        let mut want = base();
        want[1] = "L2".into();
        assert_eq!(second, format!("{}\n", want.join("\n")));
        let first = revert_hunk(&text, &rows(), 0).unwrap_or_default();
        assert_eq!(first.split('\n').nth(1), Some("l2"));
        assert!(first.ends_with("L18\nl19\nl20\nl21\n"));
        let rest = DIFF.replace("@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n", "");
        assert_eq!(revert_hunk(&first, &parse_diff(&rest)[0].rows, 0), Some(format!("{}\n", base().join("\n"))));
        let no_nl = revert_hunk(&text[..text.len() - 1], &rows(), 0).unwrap_or_default();
        assert!(no_nl.ends_with("l21"), "no newline at the end stays so");
        let crlf = parse_diff("diff --git a/w.txt b/w.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n").remove(0).rows;
        assert_eq!(revert_hunk("a\r\nB\r\n", &crlf, 0).as_deref(), Some("a\r\nb\r\n"));
    }

    #[test]
    fn revert_refuses_a_changed_file_or_missing_hunk() {
        let text = now();
        assert_eq!(revert_hunk(&text.replace("L18", "L18!"), &rows(), 1), None);
        assert_eq!(revert_hunk(&text.replace("l17\n", ""), &rows(), 1), None, "lines moved up");
        assert_eq!(revert_hunk("l1\n", &rows(), 1), None, "shorter than the hunk");
        assert_eq!(revert_hunk(&text, &rows(), 2), None);
    }

    #[test]
    fn key_is_stable_and_changes_with_a_row() {
        let hs = hunks_of(&rows());
        assert_eq!(hunk_key(&hs[0].rows), hunk_key(&hunks_of(&parse_diff(DIFF)[0].rows)[0].rows));
        assert_ne!(hunk_key(&hs[0].rows), hunk_key(&hs[1].rows));
        assert!(hunk_key(&hs[0].rows).bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()));
    }

    #[test]
    fn key_matches_the_page_js() {
        // Values computed with v1's hunkKey in node (server/hunks.js).
        assert_eq!(hunk_key(&[]), "45h");
        assert_eq!(hunk_key(&[Row::added("a", 1)]), "375t97");
        assert_eq!(hunk_key(&[Row::gap(3)]), "3cgvfs");
        assert_eq!(hunk_key(&[Row::context("é😀", 1, 1)]), "yk5m0l");
    }

    /// Property: reverting every hunk, last first, of a random edit gives the base back; and a revert
    /// of any hunk of a file that was edited since is refused or exact, never a wrong splice.
    #[test]
    fn prop_revert_all_hunks_restores_the_base() {
        let mut rng = Rng::new(0x5eed);
        for _ in 0..400 {
            let base: Vec<String> = (0..=rng.below(60)).map(|i| format!("b{i}")).collect();
            let now = rng.edit(&base);
            let diff = crate::testrng::unified("f", &base, &now);
            let Some(f) = parse_diff(&diff).into_iter().next() else {
                continue;
            };
            let mut text = format!("{}\n", now.join("\n"));
            let n = hunks_of(&f.rows).len();
            for i in (0..n).rev() {
                text = revert_hunk(&text, &f.rows, i).unwrap_or_else(|| String::from("REFUSED"));
            }
            let want = if base.is_empty() { String::new() } else { format!("{}\n", base.join("\n")) };
            assert_eq!(text, want, "base {base:?} now {now:?}\n{diff}");
        }
    }
}
