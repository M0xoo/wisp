//! v1 compiled a spell's script with `new Function` (never running it) to refuse one that can't load.
//! wisp v2 has no JS engine on the server, so this is a structural check that never refuses valid
//! code: brackets balance outside strings, template literals, comments and regex literals. The
//! sandbox that runs the script reports anything subtler.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Prev {
    /// a value just ended: `/` divides
    Value,
    /// an operator or the start: `/` starts a regex
    Op,
}

const REGEX_AFTER_WORDS: &[&str] = &["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"];

struct Scan<'a> {
    b: &'a [u8],
    i: usize,
    stack: Vec<u8>,
}

impl Scan<'_> {
    fn quoted(&mut self, q: u8) -> Result<(), String> {
        self.i += 1;
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'\\' => self.i += 2,
                b'\n' if q != b'`' => return Err("Invalid or unexpected token".into()),
                c if c == q => return Ok(()),
                b'$' if q == b'`' && self.b.get(self.i + 1) == Some(&b'{') => {
                    self.i += 2;
                    self.stack.push(b'`');
                    self.code(true)?;
                    continue;
                }
                _ => self.i += 1,
            }
        }
        Err("Unterminated string".into())
    }

    fn regex(&mut self) -> Result<(), String> {
        self.i += 1;
        let mut class = false;
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'\\' => self.i += 1,
                b'[' => class = true,
                b']' => class = false,
                b'/' if !class => return Ok(()),
                b'\n' => return Err("Invalid regular expression: missing /".into()),
                _ => {}
            }
            self.i += 1;
        }
        Err("Invalid regular expression: missing /".into())
    }

    fn comment(&mut self) -> Result<bool, String> {
        match self.b.get(self.i + 1) {
            Some(b'/') => {
                while self.i < self.b.len() && self.b[self.i] != b'\n' {
                    self.i += 1;
                }
                Ok(true)
            }
            Some(b'*') => {
                let rest = &self.b[self.i + 2..];
                let end = rest.windows(2).position(|w| w == b"*/").ok_or("Invalid or unexpected token")?;
                self.i += end + 4;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn close(&mut self, c: u8) -> Result<bool, String> {
        let want = match c {
            b')' => b'(',
            b']' => b'[',
            _ => b'{',
        };
        match self.stack.pop() {
            Some(open) if open == want => Ok(false),
            // `}` closes a `${` inside a template literal: back to the string
            Some(b'`') if c == b'}' => Ok(true),
            _ => Err(format!("Unexpected token '{}'", c as char)),
        }
    }

    /// Code until the end, or (in a template) until the `}` that closes its `${`.
    fn code(&mut self, in_template: bool) -> Result<(), String> {
        let mut prev = Prev::Op;
        while self.i < self.b.len() {
            let c = self.b[self.i];
            match c {
                b'\'' | b'"' | b'`' => {
                    self.quoted(c)?;
                    prev = Prev::Value;
                }
                b'/' if self.comment()? => continue,
                b'/' if prev == Prev::Op => {
                    self.regex()?;
                    prev = Prev::Value;
                }
                b'(' | b'[' | b'{' => {
                    self.stack.push(c);
                    prev = Prev::Op;
                }
                b')' | b']' | b'}' => {
                    if self.close(c)? && in_template {
                        self.i += 1;
                        return Ok(());
                    }
                    prev = if c == b'}' { Prev::Op } else { Prev::Value };
                }
                c if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80 => {
                    let start = self.i;
                    while self.i < self.b.len() && (self.b[self.i].is_ascii_alphanumeric() || matches!(self.b[self.i], b'_' | b'$' | b'.') || self.b[self.i] >= 0x80) {
                        self.i += 1;
                    }
                    let word = std::str::from_utf8(&self.b[start..self.i]).unwrap_or("");
                    prev = if REGEX_AFTER_WORDS.contains(&word) { Prev::Op } else { Prev::Value };
                    continue;
                }
                c if c.is_ascii_whitespace() => {}
                _ => prev = Prev::Op,
            }
            self.i += 1;
        }
        Ok(())
    }
}

/// Why the script can't load, or None.
pub fn script_problem(src: &str) -> Option<String> {
    let mut s = Scan { b: src.as_bytes(), i: 0, stack: Vec::new() };
    if let Err(e) = s.code(false) {
        return Some(e);
    }
    (!s.stack.is_empty()).then(|| "Unexpected end of input".into())
}

#[cfg(test)]
mod tests {
    use super::script_problem;

    #[test]
    fn valid_code_passes_and_broken_brackets_fail() {
        for ok in [
            "export function f(a) { return a / 2 / (1 + 1); }",
            "const re = /[}{]/g; export const g = (s) => s.replace(re, '');",
            "export function t(x) { return `a ${x.map((y) => `${y}}`).join('')} b`; }",
            "// a } comment\n/* and { another */ export function n() { return '}'; }",
            "export function c(b){return b.items.length?[{type:'stats',items:[]}]:[]}",
        ] {
            assert_eq!(script_problem(ok), None, "{ok}");
        }
        for bad in ["export function f( {", "export function f() { return [1, 2; }", "const s = 'open", "export function f() {"] {
            assert!(script_problem(bad).is_some(), "{bad}");
        }
    }
}
