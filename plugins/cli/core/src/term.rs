//! Drawing text for a terminal: SGR colour only when the style allows it, OSC 8 links, display width
//! without escapes, and wrapping to the width.

use wisp_cli_api::Style;

pub const BOLD: &str = "1";
pub const DIM: &str = "2";
pub const ITALIC: &str = "3";
pub const UNDER: &str = "4";
pub const RED: &str = "31";
pub const GREEN: &str = "32";
pub const YELLOW: &str = "33";
pub const BLUE: &str = "34";
pub const MAGENTA: &str = "35";
pub const CYAN: &str = "36";

/// `text` in SGR `code` (`"1;32"`), or as it is without colour.
pub fn paint(s: &Style, code: &str, text: &str) -> String {
    if s.color && !text.is_empty() { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_owned() }
}

pub fn bold(s: &Style, t: &str) -> String {
    paint(s, BOLD, t)
}
pub fn dim(s: &Style, t: &str) -> String {
    paint(s, DIM, t)
}

/// A clickable link (OSC 8) where the terminal takes it; else the label, then the url when they differ.
pub fn link(s: &Style, label: &str, url: &str) -> String {
    if url.is_empty() {
        return label.to_owned();
    }
    if s.links {
        return format!("\x1b]8;;{url}\x1b\\{}\x1b]8;;\x1b\\", paint(s, UNDER, label));
    }
    if label.is_empty() || label == url { url.to_owned() } else { format!("{label} <{url}>") }
}

/// Columns `text` takes: escapes (CSI and OSC) count for nothing, a wide character for two.
pub fn width(text: &str) -> usize {
    let mut w = 0;
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            match it.next() {
                Some('[') => {
                    for d in it.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // to BEL or ST (ESC \)
                    while let Some(d) = it.next() {
                        if d == '\x07' {
                            break;
                        }
                        if d == '\x1b' {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        w += char_width(c);
    }
    w
}

/// East Asian wide and emoji ranges take two columns; combining marks none.
pub fn char_width(c: char) -> usize {
    let u = c as u32;
    if c.is_control() || (0x300..=0x36F).contains(&u) || (0xFE00..=0xFE0F).contains(&u) || u == 0x200D {
        return 0;
    }
    let wide = (0x1100..=0x115F).contains(&u)
        || (0x2E80..=0xA4CF).contains(&u)
        || (0xAC00..=0xD7A3).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0xFE30..=0xFE4F).contains(&u)
        || (0xFF00..=0xFF60).contains(&u)
        || (0xFFE0..=0xFFE6).contains(&u)
        || (0x1F300..=0x1FAFF).contains(&u)
        || (0x20000..=0x3FFFD).contains(&u);
    if wide { 2 } else { 1 }
}

/// The escape sequence (CSI or OSC) at the start of `s`, if one starts there.
fn escape_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.first() != Some(&0x1b) {
        return None;
    }
    match b.get(1) {
        Some(b'[') => b[2..].iter().position(|c| (0x40..=0x7e).contains(c)).map(|p| p + 3),
        Some(b']') => {
            let mut i = 2;
            while i < b.len() {
                if b[i] == 0x07 {
                    return Some(i + 1);
                }
                if b[i] == 0x1b && b.get(i + 1) == Some(&b'\\') {
                    return Some(i + 2);
                }
                i += 1;
            }
            Some(b.len())
        }
        _ => Some(1),
    }
}

/// Text cut to `max` columns, with `…` when it was longer. Escapes are kept whole (and closed).
pub fn truncate(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut w = 0;
    let mut i = 0;
    let mut escaped = false;
    while i < text.len() {
        if let Some(n) = escape_len(&text[i..]) {
            out.push_str(&text[i..i + n]);
            escaped = true;
            i += n;
            continue;
        }
        let Some(c) = text[i..].chars().next() else { break };
        let cw = char_width(c);
        if w + cw + 1 > max {
            break;
        }
        out.push(c);
        w += cw;
        i += c.len_utf8();
    }
    out.push('…');
    if escaped {
        out.push_str("\x1b[0m");
    }
    out
}

/// Plain text padded with spaces to `n` columns (longer text is left as it is).
pub fn pad(text: &str, n: usize) -> String {
    let w = width(text);
    if w >= n { text.to_owned() } else { format!("{text}{}", " ".repeat(n - w)) }
}

pub fn pad_left(text: &str, n: usize) -> String {
    let w = width(text);
    if w >= n { text.to_owned() } else { format!("{}{text}", " ".repeat(n - w)) }
}

/// Words wrapped to `max` columns; a word longer than a line is cut. Escapes inside words are kept
/// (they take no width). Empty text is one empty line.
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let max = max.max(8);
    let mut out = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        let mut w = 0;
        for word in para.split(' ') {
            let ww = width(word);
            if w > 0 && w + 1 + ww > max {
                out.push(std::mem::take(&mut line));
                w = 0;
            }
            if ww > max && w == 0 {
                let mut chunk = String::new();
                let mut cw = 0;
                for c in word.chars() {
                    let x = char_width(c);
                    if cw + x > max {
                        out.push(std::mem::take(&mut chunk));
                        cw = 0;
                    }
                    chunk.push(c);
                    cw += x;
                }
                line = chunk;
                w = cw;
                continue;
            }
            if w > 0 {
                line.push(' ');
                w += 1;
            }
            line.push_str(word);
            w += ww;
        }
        out.push(line);
    }
    out
}

/// `prefix` on the first line, `indent` (its width in spaces) on the rest, text wrapped between.
pub fn hang(prefix: &str, text: &str, max: usize) -> Vec<String> {
    let pw = width(prefix);
    let lines = wrap(text, max.saturating_sub(pw));
    lines.into_iter().enumerate().map(|(i, l)| if i == 0 { format!("{prefix}{l}") } else { format!("{}{l}", " ".repeat(pw)) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_skips_escapes_and_counts_wide_characters() {
        let s = Style::color(80);
        assert_eq!(width(&paint(&s, BOLD, "hi")), 2);
        assert_eq!(width(&link(&s, "docs", "https://x.dev")), 4);
        assert_eq!(width("日本"), 4);
        assert_eq!(width("e\u{301}"), 1);
    }

    #[test]
    fn wrap_and_truncate() {
        assert_eq!(wrap("one two three four", 9), ["one two", "three", "four"]);
        assert_eq!(wrap("abcdefghijkl", 8), ["abcdefgh", "ijkl"]);
        assert_eq!(truncate("hello world", 6), "hello…");
        assert_eq!(hang("- ", "one two three", 10), ["- one two", "  three"]);
    }

    #[test]
    fn plain_has_no_escapes() {
        let s = Style::plain(80);
        assert_eq!(paint(&s, RED, "x"), "x");
        assert_eq!(link(&s, "docs", "https://x.dev"), "docs <https://x.dev>");
    }
}
