//! Regular expressions as v1 wrote them, compiled once, with no panic: a pattern that fails to compile
//! matches nothing (each module's tests compile every pattern it declares, so that never ships).
//!
//! JavaScript's `\s`, `\w` and `\d` are narrower than the `regex` crate's Unicode classes: write
//! `wisp_harness_kit::js_s!()`, `js_w!()` and `js_d!()` inside `concat!` to say exactly what v1 meant.

use std::sync::OnceLock;

pub use regex::{Captures, Regex};

/// JavaScript's `\s` as a regex class body (use inside `[...]` or via `js_s!`).
#[macro_export]
macro_rules! js_s {
    () => {
        r"[\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"
    };
}

/// JavaScript's `\S`.
#[macro_export]
macro_rules! js_not_s {
    () => {
        r"[^\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"
    };
}

/// JavaScript's `\w`: ASCII letters, digits and `_`.
#[macro_export]
macro_rules! js_w {
    () => {
        r"[A-Za-z0-9_]"
    };
}

/// JavaScript's `\d`: ASCII digits.
#[macro_export]
macro_rules! js_d {
    () => {
        r"[0-9]"
    };
}

/// A lazily compiled pattern: `static RE: Re = Re::new(r"…");`
#[derive(Debug)]
pub struct Re {
    pattern: &'static str,
    cell: OnceLock<Option<Regex>>,
}

impl Re {
    pub const fn new(pattern: &'static str) -> Self {
        Self {
            pattern,
            cell: OnceLock::new(),
        }
    }

    pub fn pattern(&self) -> &'static str {
        self.pattern
    }

    /// The compiled regex, or None when the pattern is broken (a test catches that).
    pub fn get(&self) -> Option<&Regex> {
        self.cell
            .get_or_init(|| Regex::new(self.pattern).ok())
            .as_ref()
    }

    /// Whether the pattern compiles (for tests).
    pub fn compiles(&self) -> bool {
        self.get().is_some()
    }

    pub fn is_match(&self, s: &str) -> bool {
        self.get().is_some_and(|r| r.is_match(s))
    }

    pub fn captures<'h>(&self, s: &'h str) -> Option<Captures<'h>> {
        self.get().and_then(|r| r.captures(s))
    }

    /// The first match's text.
    pub fn find<'h>(&self, s: &'h str) -> Option<&'h str> {
        self.get().and_then(|r| r.find(s)).map(|m| m.as_str())
    }

    /// The byte offset of the first match (JavaScript's `s.search(re)`, in bytes).
    pub fn search(&self, s: &str) -> Option<usize> {
        self.get().and_then(|r| r.find(s)).map(|m| m.start())
    }

    /// Group `i` of the first match, or None.
    pub fn group<'h>(&self, s: &'h str, i: usize) -> Option<&'h str> {
        self.captures(s).and_then(|c| c.get(i)).map(|m| m.as_str())
    }

    /// `s.replace(re, with)` for a global pattern: every match. `$1` refers to groups, as in JavaScript.
    pub fn replace_all<'h>(&self, s: &'h str, with: &str) -> std::borrow::Cow<'h, str> {
        match self.get() {
            Some(r) => r.replace_all(s, with),
            None => std::borrow::Cow::Borrowed(s),
        }
    }

    /// `s.replace(re, with)` for a non-global pattern: the first match only.
    pub fn replace<'h>(&self, s: &'h str, with: &str) -> std::borrow::Cow<'h, str> {
        match self.get() {
            Some(r) => r.replace(s, with),
            None => std::borrow::Cow::Borrowed(s),
        }
    }

    /// `s.split(re)`
    pub fn split<'h>(&self, s: &'h str) -> Vec<&'h str> {
        match self.get() {
            Some(r) => r.split(s).collect(),
            None => vec![s],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static SPACE: Re = Re::new(concat!("^", crate::js_s!(), "+$"));
    static BROKEN: Re = Re::new("(");

    #[test]
    fn js_classes() {
        assert!(SPACE.is_match(" \u{feff}\u{a0}"));
        assert!(!SPACE.is_match("\u{85}"));
        assert!(!BROKEN.compiles());
        assert!(!BROKEN.is_match("("));
    }
}
