//! v1's string helpers (server/util.js clip and truncate), with JavaScript's semantics: lengths count
//! UTF-16 units and `\s` / `trim()` are JavaScript's whitespace, so a cut lands where v1's did.

use std::sync::OnceLock;

use regex::Regex;

/// JavaScript's `\s` as a regex class, for `concat!` (the `regex` crate's `\s` is Unicode's, a
/// slightly other set).
macro_rules! js_s {
    () => {
        r"[\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"
    };
}
pub(crate) use js_s;

/// Whether `c` is whitespace to JavaScript (`\s`, `trim()`).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `s.trim()`
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.length`
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 units (a pair `n` would split is left out whole).
pub(crate) fn head16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// One line, at most `n` characters (whitespace collapsed): v1 `clip(s, n)`.
pub fn clip(s: &str, n: usize) -> String {
    let mut collapsed = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !space {
                collapsed.push(' ');
            }
            space = true;
        } else {
            collapsed.push(c);
            space = false;
        }
    }
    let t = trim(&collapsed);
    if len16(t) > n {
        let mut out = head16(t, n.saturating_sub(1)).to_owned();
        out.push('…');
        out
    } else {
        t.to_owned()
    }
}

/// At most `n` characters, newlines kept: v1 `truncate(s, n)`.
pub fn truncate(s: &str, n: usize) -> String {
    if len16(s) > n {
        let mut out = head16(s, n.saturating_sub(1)).to_owned();
        out.push('…');
        out
    } else {
        s.to_owned()
    }
}

/// `parts.filter(Boolean).join(sep)`
pub(crate) fn join_some<S: AsRef<str>>(parts: &[S], sep: &str) -> String {
    let mut out = String::new();
    for p in parts.iter().map(AsRef::as_ref).filter(|p| !p.is_empty()) {
        if !out.is_empty() {
            out.push_str(sep);
        }
        out.push_str(p);
    }
    out
}

/// `n` and its noun, with an s past one: "3 turns".
pub(crate) fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// A lazily compiled pattern that never panics: a broken one matches nothing, and each module's
/// tests compile every pattern it declares, so that never ships.
#[derive(Debug)]
pub(crate) struct Re {
    pattern: &'static str,
    cell: OnceLock<Option<Regex>>,
}

impl Re {
    pub(crate) const fn new(pattern: &'static str) -> Self {
        Self { pattern, cell: OnceLock::new() }
    }

    pub(crate) fn get(&self) -> Option<&Regex> {
        self.cell.get_or_init(|| Regex::new(self.pattern).ok()).as_ref()
    }

    pub(crate) fn is_match(&self, s: &str) -> bool {
        self.get().is_some_and(|r| r.is_match(s))
    }

    /// `s.replace(re, with)` for a global pattern (`${1}` names a group).
    pub(crate) fn replace_all<'h>(&self, s: &'h str, with: &str) -> std::borrow::Cow<'h, str> {
        match self.get() {
            Some(r) => r.replace_all(s, with),
            None => std::borrow::Cow::Borrowed(s),
        }
    }

    /// `s.replace(re, with)` for a pattern without `g`: the first match only.
    pub(crate) fn replace<'h>(&self, s: &'h str, with: &str) -> std::borrow::Cow<'h, str> {
        match self.get() {
            Some(r) => r.replace(s, with),
            None => std::borrow::Cow::Borrowed(s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_and_truncate_count_as_javascript_does() {
        assert_eq!(clip("  a \n\t b  ", 80), "a b");
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(truncate("ab\ncdef", 4), "ab\n…");
        assert_eq!(truncate("abc", 3), "abc");
        // an emoji is two UTF-16 units, as v1 counted it
        assert_eq!(len16("😀a"), 3);
        assert_eq!(head16("😀a", 1), "");
        assert_eq!(trim("\u{FEFF} x \u{A0}"), "x");
        assert_eq!(join_some(&["a", "", "b"], ", "), "a, b");
        assert_eq!(plural(1, "turn"), "1 turn");
        assert_eq!(plural(2, "turn"), "2 turns");
    }
}
