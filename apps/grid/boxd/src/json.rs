//! Just enough JSON for boxd's protocol (one object per line), with std only: boxd runs as root, so it pulls in
//! nothing (ADR-0014). Numbers are f64; objects keep their order.

#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, k: &str) -> Option<&J> {
        match self {
            Self::Obj(o) => o.iter().find(|(x, _)| x == k).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn num(&self) -> Option<f64> {
        match self {
            Self::Num(n) => Some(*n),
            Self::Str(s) => s.parse().ok(),
            _ => None,
        }
    }
    /// A value as text the way JavaScript's `String(v)` reads it (a number without its `.0`).
    pub fn text(&self) -> String {
        match self {
            Self::Str(s) => s.clone(),
            Self::Num(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{n:.0}"),
            Self::Num(n) => n.to_string(),
            Self::Bool(b) => b.to_string(),
            Self::Null => "null".into(),
            other => other.to_string(),
        }
    }
    pub fn obj(pairs: Vec<(&str, J)>) -> Self {
        Self::Obj(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }
}

fn esc(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl std::fmt::Display for J {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut out = String::new();
        match self {
            Self::Num(n) if n.is_finite() => out.push_str(&self.text()),
            Self::Null | Self::Num(_) => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Str(s) => esc(s, &mut out),
            Self::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&v.to_string());
                }
                out.push(']');
            }
            Self::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    esc(k, &mut out);
                    out.push(':');
                    out.push_str(&v.to_string());
                }
                out.push('}');
            }
        }
        f.write_str(&out)
    }
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.b.get(self.i).is_some_and(u8::is_ascii_whitespace) {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected {} at {}", c as char, self.i))
        }
    }
    fn lit(&mut self, w: &str, v: J) -> Result<J, String> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Ok(v)
        } else {
            Err(format!("bad literal at {}", self.i))
        }
    }
    fn value(&mut self) -> Result<J, String> {
        self.ws();
        self.depth += 1;
        if self.depth > 32 {
            return Err("nested too deep".into());
        }
        let v = match self.b.get(self.i) {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(J::Str),
            Some(b't') => self.lit("true", J::Bool(true)),
            Some(b'f') => self.lit("false", J::Bool(false)),
            Some(b'n') => self.lit("null", J::Null),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.number(),
            _ => Err(format!("unexpected at {}", self.i)),
        };
        self.depth -= 1;
        v
    }
    fn number(&mut self) -> Result<J, String> {
        let start = self.i;
        while self.b.get(self.i).is_some_and(|c| c.is_ascii_digit() || b"+-.eE".contains(c)) {
            self.i += 1;
        }
        std::str::from_utf8(&self.b[start..self.i]).ok().and_then(|s| s.parse().ok()).map(J::Num).ok_or_else(|| format!("bad number at {start}"))
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.b.get(self.i..self.i + 4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok()).ok_or("bad \\u escape")?;
        self.i += 4;
        Ok(h)
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let Some(&c) = self.b.get(self.i) else { return Err("unterminated string".into()) };
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let Some(&e) = self.b.get(self.i) else { return Err("bad escape".into()) };
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) && self.b.get(self.i..self.i + 2) == Some(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                0x10000 + ((hi - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF)
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        }
                        _ => return Err("bad escape".into()),
                    }
                }
                _ => {
                    // a UTF-8 sequence, whole
                    let len = match c {
                        0x00..=0x7F => 1,
                        0xC0..=0xDF => 2,
                        0xE0..=0xEF => 3,
                        _ => 4,
                    };
                    let s = self.b.get(self.i - 1..self.i - 1 + len).and_then(|s| std::str::from_utf8(s).ok()).ok_or("not UTF-8")?;
                    out.push_str(s);
                    self.i += len - 1;
                }
            }
        }
    }
    fn array(&mut self) -> Result<J, String> {
        self.i += 1;
        let mut out = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(J::Arr(out));
        }
        loop {
            out.push(self.value()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(J::Arr(out));
                }
                _ => return Err(format!("expected , or ] at {}", self.i)),
            }
        }
    }
    fn object(&mut self) -> Result<J, String> {
        self.i += 1;
        let mut out = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(J::Obj(out));
        }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(format!("expected a key at {}", self.i));
            }
            let k = self.string()?;
            self.eat(b':')?;
            out.push((k, self.value()?));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(J::Obj(out));
                }
                _ => return Err(format!("expected , or }} at {}", self.i)),
            }
        }
    }
}

pub fn parse(s: &str) -> Result<J, String> {
    let mut p = P { b: s.as_bytes(), i: 0, depth: 0 };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("trailing text at {}", p.i));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trips_what_the_protocol_sends() {
        let s = r#"{"op":"run","id":"u1","port":4100,"env":{"A":"x\ny","B":"é é 😀"},"dns":["1.1.1.1"],"sandbox":false,"n":null}"#;
        let v = parse(s).unwrap_or(J::Null);
        assert_eq!(v.get("port").and_then(J::num), Some(4100.0));
        assert_eq!(v.get("env").and_then(|e| e.get("A")).and_then(J::str), Some("x\ny"));
        assert_eq!(v.get("env").and_then(|e| e.get("B")).and_then(J::str), Some("é é 😀"));
        assert_eq!(parse(&v.to_string()).unwrap_or(J::Null), v);
        assert_eq!(J::Num(4100.0).text(), "4100");
        for bad in ["{", "{\"a\":}", "[1,]", "\"open", "{} x", "nul"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        assert!(parse(&"[".repeat(100)).is_err(), "too deep");
    }
}
