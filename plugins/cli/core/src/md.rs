//! Markdown for the terminal (ADR-0022): headings bold, lists hung, code framed with its language,
//! quotes with a margin, `code` / **bold** / *italic* inline, links as OSC 8 hyperlinks.

use wisp_cli_api::Style;

use crate::term::{self, BOLD, CYAN, DIM, ITALIC, MAGENTA, UNDER, paint};

/// `**bold**`, `*italic*`, `` `code` `` and `[label](url)` in one line of text.
#[allow(clippy::many_single_char_names)]
pub fn inline(s: &Style, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if let Some(r) = rest.strip_prefix('`')
            && let Some(end) = r.find('`')
        {
            out.push_str(&paint(s, CYAN, &r[..end]));
            i += end + 2;
            continue;
        }
        if let Some(r) = rest.strip_prefix("**")
            && let Some(end) = r.find("**").filter(|e| *e > 0)
        {
            out.push_str(&paint(s, BOLD, &r[..end]));
            i += end + 4;
            continue;
        }
        if b[i] == b'*' || b[i] == b'_' {
            let m = b[i] as char;
            let r = &rest[1..];
            if let Some(end) = r.find(m).filter(|e| *e > 0 && !r.starts_with(' '))
                && (i == 0 || !b[i - 1].is_ascii_alphanumeric())
            {
                out.push_str(&paint(s, ITALIC, &r[..end]));
                i += end + 2;
                continue;
            }
        }
        if let Some(r) = rest.strip_prefix('[')
            && let Some(close) = r.find("](")
            && let Some(end) = r[close + 2..].find(')')
        {
            let label = &r[..close];
            let url = &r[close + 2..close + 2 + end];
            out.push_str(&term::link(s, label, url));
            i += 1 + close + 2 + end + 1;
            continue;
        }
        let c = rest.chars().next().unwrap_or(' ');
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// A fenced code block, framed (`┌─ lang`, `│ …`, `└─`), lines cut to the width.
pub fn code(s: &Style, lang: &str, title: &str, lines: &[&str], highlight: &[usize]) -> Vec<String> {
    let w = s.width.max(10);
    let head = [title, lang].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join(" · ");
    let mut out = vec![paint(s, DIM, &term::truncate(&if head.is_empty() { "┌─".to_owned() } else { format!("┌─ {head}") }, w))];
    for (n, l) in lines.iter().enumerate() {
        let body = term::truncate(&l.replace('\t', "    "), w - 2);
        let body = if highlight.contains(&(n + 1)) { paint(s, BOLD, &body) } else { paint(s, MAGENTA, &body) };
        out.push(format!("{} {body}", paint(s, DIM, "│")));
    }
    out.push(paint(s, DIM, "└─"));
    out
}

fn heading(s: &Style, level: usize, text: &str) -> Vec<String> {
    let t = inline(s, text);
    let lines = term::wrap(&t, s.width);
    lines.into_iter().map(|l| if level == 1 { paint(s, &format!("{BOLD};{UNDER}"), &l) } else { paint(s, BOLD, &l) }).collect()
}

/// The list marker of a line (`- `, `* `, `1. `) and the text after it.
fn bullet(line: &str) -> Option<(String, &str)> {
    let t = line.trim_start();
    let indent = line.len() - t.len();
    for m in ["- ", "* ", "+ "] {
        if let Some(r) = t.strip_prefix(m) {
            let (mark, r) = if let Some(x) = r.strip_prefix("[ ] ") { ("☐ ", x) } else if let Some(x) = r.strip_prefix("[x] ").or_else(|| r.strip_prefix("[X] ")) { ("☑ ", x) } else { ("• ", r) };
            return Some((format!("{}{mark}", " ".repeat(indent)), r));
        }
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && t[digits..].starts_with(". ") {
        return Some((format!("{}{} ", " ".repeat(indent), &t[..=digits]), &t[digits + 2..]));
    }
    None
}

/// Markdown text as terminal lines, `s.width` wide.
pub fn render(s: &Style, text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut fence: Option<(String, Vec<String>)> = None;
    let mut para: Vec<String> = Vec::new();
    let flush = |para: &mut Vec<String>, out: &mut Vec<String>| {
        if !para.is_empty() {
            out.extend(term::wrap(&inline(s, &para.join(" ")), s.width));
            para.clear();
        }
    };
    for line in text.lines() {
        if let Some((lang, body)) = fence.as_mut() {
            if line.trim_start().starts_with("```") {
                let refs: Vec<&str> = body.iter().map(String::as_str).collect();
                out.extend(code(s, lang, "", &refs, &[]));
                fence = None;
            } else {
                body.push(line.to_owned());
            }
            continue;
        }
        let t = line.trim();
        if let Some(lang) = t.strip_prefix("```") {
            flush(&mut para, &mut out);
            fence = Some((lang.trim().to_owned(), Vec::new()));
            continue;
        }
        if t.is_empty() {
            flush(&mut para, &mut out);
            if out.last().is_some_and(|l| !l.is_empty()) {
                out.push(String::new());
            }
            continue;
        }
        let hashes = t.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
            flush(&mut para, &mut out);
            out.extend(heading(s, hashes, t[hashes..].trim()));
            continue;
        }
        if t == "---" || t == "***" {
            flush(&mut para, &mut out);
            out.push(paint(s, DIM, &"─".repeat(s.width.min(40))));
            continue;
        }
        if let Some(q) = t.strip_prefix('>') {
            flush(&mut para, &mut out);
            let bar = paint(s, DIM, "│ ");
            out.extend(term::wrap(&inline(s, q.trim()), s.width.saturating_sub(2)).into_iter().map(|l| format!("{bar}{l}")));
            continue;
        }
        if let Some((mark, rest)) = bullet(line) {
            flush(&mut para, &mut out);
            out.extend(term::hang(&mark, &inline(s, rest), s.width));
            continue;
        }
        if t.starts_with('|') {
            flush(&mut para, &mut out);
            if !t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
                let cells: Vec<String> = t.trim_matches('|').split('|').map(|c| inline(s, c.trim())).collect();
                out.push(term::truncate(&cells.join("  │  "), s.width));
            }
            continue;
        }
        para.push(t.to_owned());
    }
    if let Some((lang, body)) = fence {
        let refs: Vec<&str> = body.iter().map(String::as_str).collect();
        out.extend(code(s, &lang, "", &refs, &[]));
    }
    flush(&mut para, &mut out);
    while out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_markdown() {
        let s = Style::plain(40);
        let got = render(&s, "# Title\n\nSome **bold** and `code` with a [link](https://x.dev).\n\n- one\n- [x] two\n1. first\n\n```rs\nfn main() {}\n```\n> quoted");
        assert_eq!(got, ["Title", "", "Some bold and code with a link", "<https://x.dev>.", "", "• one", "☑ two", "1. first", "", "┌─ rs", "│ fn main() {}", "└─", "│ quoted"]);
    }

    #[test]
    fn colour_and_links() {
        let s = Style::color(80);
        let got = inline(&s, "a **b** [c](https://x)");
        assert!(got.contains("\x1b[1mb\x1b[0m") && got.contains("\x1b]8;;https://x\x1b\\"), "{got:?}");
    }
}
