//! Diffs for the terminal: a line diff (LCS, bounded) of a change's before and after, drawn unified when narrow and
//! side by side when wide, with hunk starts to jump between, and a light syntax colouring (keywords, strings,
//! comments, numbers) in the theme's `tk` tokens.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::Theme;

/// One line of a diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Same(String),
    Add(String),
    Del(String),
}

/// Lines past this go through a cheap prefix/suffix diff instead of the full one.
const LCS_MAX: usize = 2_000;

/// The line diff of `before` → `after`.
#[allow(clippy::many_single_char_names)] // the LCS's usual names
pub fn lines(before: &str, after: &str) -> Vec<Row> {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let pre = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suf = a[pre..].iter().rev().zip(b[pre..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (am, bm) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut out: Vec<Row> = a[..pre].iter().map(|l| Row::Same((*l).to_owned())).collect();
    if am.len() * bm.len() <= LCS_MAX * LCS_MAX / 4 && am.len() <= LCS_MAX && bm.len() <= LCS_MAX {
        // LCS table over the middle
        let (n, m) = (am.len(), bm.len());
        let mut t = vec![vec![0u32; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                t[i][j] = if am[i] == bm[j] { t[i + 1][j + 1] + 1 } else { t[i + 1][j].max(t[i][j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && am[i] == bm[j] {
                out.push(Row::Same(am[i].to_owned()));
                i += 1;
                j += 1;
            } else if i < n && (j == m || t[i + 1][j] >= t[i][j + 1]) {
                // a removed line before the line added in its place, as diffs read
                out.push(Row::Del(am[i].to_owned()));
                i += 1;
            } else {
                out.push(Row::Add(bm[j].to_owned()));
                j += 1;
            }
        }
    } else {
        out.extend(am.iter().map(|l| Row::Del((*l).to_owned())));
        out.extend(bm.iter().map(|l| Row::Add((*l).to_owned())));
    }
    out.extend(a[a.len() - suf..].iter().map(|l| Row::Same((*l).to_owned())));
    out
}

/// A unified diff's text (a tool's `detail`) as rows; `@@` headers and `---`/`+++` lines dropped. None when it isn't one.
pub fn parse_unified(text: &str) -> Option<Vec<Row>> {
    if !text.lines().any(|l| l.starts_with("@@")) {
        return None;
    }
    Some(
        text.lines()
            .filter(|l| !(l.starts_with("+++") || l.starts_with("---") || l.starts_with("diff ") || l.starts_with("index ") || l.starts_with("@@")))
            .map(|l| match l.chars().next() {
                Some('+') => Row::Add(l[1..].to_owned()),
                Some('-') => Row::Del(l[1..].to_owned()),
                Some(' ') => Row::Same(l[1..].to_owned()),
                _ => Row::Same(l.to_owned()),
            })
            .collect(),
    )
}

/// `+added −removed`.
pub fn counts(rows: &[Row]) -> (usize, usize) {
    rows.iter().fold((0, 0), |(a, d), r| match r {
        Row::Add(_) => (a + 1, d),
        Row::Del(_) => (a, d + 1),
        Row::Same(_) => (a, d),
    })
}

/// Rows to show: each change with `ctx` lines around it, and where each hunk starts (index into the result).
pub fn hunks(rows: &[Row], ctx: usize) -> (Vec<Option<&Row>>, Vec<usize>) {
    let changed: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| !matches!(r, Row::Same(_))).map(|(i, _)| i).collect();
    let keep = |i: usize| changed.iter().any(|c| i + ctx >= *c && i <= c + ctx);
    let mut out = Vec::new();
    let mut starts = Vec::new();
    let mut gap = true;
    for (i, r) in rows.iter().enumerate() {
        if keep(i) {
            if gap {
                if !out.is_empty() {
                    out.push(None); // a "⋯" between hunks
                }
                starts.push(out.len());
            }
            out.push(Some(r));
            gap = false;
        } else {
            gap = true;
        }
    }
    (out, starts)
}

const KEYWORDS: [&str; 34] = ["fn", "let", "mut", "pub", "use", "impl", "struct", "enum", "match", "if", "else", "for", "while", "loop", "return", "async", "await", "const", "static", "trait", "type", "function", "var", "export", "import", "from", "class", "def", "self", "true", "false", "null", "None", "new"];

/// One line of code, coloured lightly.
pub fn highlight(line: &str, th: &Theme, base: Style) -> Vec<Span<'static>> {
    let [kw, st, cm, nu, _ty] = th.tk;
    let mut out = Vec::new();
    if let Some(i) = line.find("//").or_else(|| line.trim_start().starts_with('#').then(|| line.find('#').unwrap_or(0))) {
        out.extend(highlight(&line[..i], th, base));
        out.push(Span::styled(line[i..].to_owned(), base.fg(cm)));
        return out;
    }
    let mut word = String::new();
    let mut chars = line.chars().peekable();
    let flush = |w: &mut String, out: &mut Vec<Span<'static>>| {
        if w.is_empty() {
            return;
        }
        let s = if KEYWORDS.contains(&w.as_str()) { base.fg(kw) } else if w.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '_') && w.starts_with(|c: char| c.is_ascii_digit()) { base.fg(nu) } else { base };
        out.push(Span::styled(std::mem::take(w), s));
    };
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' || c == '`' {
            flush(&mut word, &mut out);
            let mut s = String::from(c);
            while let Some(d) = chars.next() {
                s.push(d);
                if d == '\\' {
                    if let Some(e) = chars.next() {
                        s.push(e);
                    }
                } else if d == c {
                    break;
                }
            }
            out.push(Span::styled(s, base.fg(st)));
        } else if c.is_alphanumeric() || c == '_' || c == '.' && !word.is_empty() && word.chars().all(|x| x.is_ascii_digit()) {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(Span::styled(c.to_string(), base));
        }
    }
    flush(&mut word, &mut out);
    out
}

/// One diff line, padded to `width`: an added line on `add-bg`, a removed one on `del-bg`, the sign in its colour.
fn sign_line(r: Option<&Row>, th: &Theme, width: usize) -> Line<'static> {
    let (sign, text, base, sign_fg) = match r {
        None => return Line::from(Span::styled("  ⋯", th.dim())),
        Some(Row::Same(t)) => (' ', t, Style::default().fg(th.ink2), th.ink2),
        Some(Row::Add(t)) => ('+', t, Style::default().fg(th.ink).bg(th.add_bg), th.add),
        Some(Row::Del(t)) => ('−', t, Style::default().fg(th.ink).bg(th.del_bg), th.del),
    };
    let mut spans = vec![Span::styled(format!("{sign} "), base.fg(sign_fg).add_modifier(Modifier::BOLD))];
    let t: String = text.chars().take(width.saturating_sub(2)).collect();
    let n = t.chars().count() + 2;
    spans.extend(highlight(&t, th, base));
    if n < width && base.bg.is_some() {
        spans.push(Span::styled(" ".repeat(width - n), base));
    }
    Line::from(spans)
}

/// The diff as lines: side by side when `width` ≥ 120, else unified. → (lines, hunk start lines).
pub fn render(rows: &[Row], width: u16, th: &Theme) -> (Vec<Line<'static>>, Vec<usize>) {
    let (shown, starts) = hunks(rows, 3);
    let w = usize::from(width);
    if w < 120 {
        return (shown.iter().map(|r| sign_line(*r, th, w)).collect(), starts);
    }
    // side by side: a removed line beside the line added in its place
    let half = (w - 3) / 2;
    let mut out = Vec::new();
    let mut new_starts = Vec::new();
    let mut i = 0;
    while i < shown.len() {
        if starts.contains(&i) {
            new_starts.push(out.len());
        }
        match shown[i] {
            Some(Row::Del(_)) => {
                let dels: Vec<&Row> = shown[i..].iter().take_while(|r| matches!(r, Some(Row::Del(_)))).filter_map(|r| *r).collect();
                let adds: Vec<&Row> = shown[i + dels.len()..].iter().take_while(|r| matches!(r, Some(Row::Add(_)))).filter_map(|r| *r).collect();
                for k in 0..dels.len().max(adds.len()) {
                    out.push(pair(dels.get(k).copied(), adds.get(k).copied(), half, th));
                }
                i += dels.len() + adds.len();
                continue;
            }
            Some(Row::Add(_)) => out.push(pair(None, shown[i], half, th)),
            r => out.push(pair(r, r, half, th)),
        }
        i += 1;
    }
    (out, new_starts)
}

fn pair(l: Option<&Row>, r: Option<&Row>, half: usize, th: &Theme) -> Line<'static> {
    let left = l.filter(|x| !matches!(x, Row::Add(_)));
    let right = r.filter(|x| !matches!(x, Row::Del(_)));
    let pad = |line: Line<'static>| {
        let mut spans = line.spans;
        let n: usize = spans.iter().map(|s| s.content.chars().count()).sum();
        if n < half {
            spans.push(Span::raw(" ".repeat(half - n)));
        }
        spans
    };
    let mut spans = pad(if left.is_some() || l.is_none() && r.is_none() { sign_line(left, th, half) } else { Line::from("") });
    spans.push(Span::styled(" │ ", Style::default().fg(th.line2)));
    spans.extend(if right.is_some() { sign_line(right, th, half).spans } else { Vec::new() });
    Line::from(spans)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_line_diff_keeps_what_stayed() {
        let rows = lines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
        assert_eq!(rows, vec![Row::Same("a".into()), Row::Del("b".into()), Row::Add("B".into()), Row::Same("c".into()), Row::Same("d".into()), Row::Add("e".into())]);
        assert_eq!(counts(&rows), (2, 1));
        let u = parse_unified("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n").unwrap();
        assert_eq!(u, vec![Row::Same("a".into()), Row::Del("b".into()), Row::Add("B".into())]);
        assert!(parse_unified("just text").is_none());
        let big: String = (0..30).fold(String::new(), |acc, i| acc + &format!("l{i}\n"));
        let changed = big.replace("l3\n", "x3\n").replace("l25\n", "x25\n");
        let rows = lines(&big, &changed);
        let (shown, starts) = hunks(&rows, 2);
        assert_eq!(starts.len(), 2, "two hunks");
        assert!(shown.contains(&None), "a gap between them");
    }

    #[test]
    fn wide_is_side_by_side_and_narrow_is_unified() {
        let rows = lines("let x = 1;\n", "let x = 2;\n");
        let th = Theme::DARK;
        let (narrow, _) = render(&rows, 80, &th);
        assert_eq!(narrow.len(), 2, "− then +");
        let (wide, _) = render(&rows, 160, &th);
        assert_eq!(wide.len(), 1, "beside each other");
        let text: String = wide[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("let x = 1;") && text.contains("│") && text.contains("let x = 2;"), "{text}");
        let hl = highlight("let s = \"hi\"; // c", &th, th.text());
        assert!(hl.iter().any(|s| s.content == "let" && s.style.fg == Some(th.tk[0])));
        assert!(hl.iter().any(|s| s.content == "\"hi\"" && s.style.fg == Some(th.tk[1])));
        assert!(hl.iter().any(|s| s.content.starts_with("//") && s.style.fg == Some(th.tk[2])));
    }
}
