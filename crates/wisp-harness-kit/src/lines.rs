//! Bytes → lines, sans-IO: the driver feeds stdout chunks as they come and gets back the complete
//! lines; nothing here reads a stream or a clock. A line may be split across chunks anywhere, even
//! inside a multi-byte character, so bytes are kept until the newline and decoded once (invalid UTF-8
//! becomes U+FFFD, as Node's decoder does).

use serde_json::Value;

/// Splits a byte stream on `\n`, dropping a `\r` before it (Node's readline does both).
#[derive(Debug, Default)]
pub struct LineSplitter {
    rest: Vec<u8>,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Calls `f` with every complete line in `chunk` (plus what earlier chunks left), without its end.
    pub fn push(&mut self, chunk: &[u8], mut f: impl FnMut(&str)) {
        let mut from = 0;
        while let Some(at) = memchr(b'\n', &chunk[from..]) {
            let end = from + at;
            if self.rest.is_empty() {
                emit(&chunk[from..end], &mut f);
            } else {
                self.rest.extend_from_slice(&chunk[from..end]);
                let line = std::mem::take(&mut self.rest);
                emit(&line, &mut f);
            }
            from = end + 1;
        }
        self.rest.extend_from_slice(&chunk[from..]);
    }

    /// The complete lines in `chunk`, owned (for callers that keep them).
    pub fn lines(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        self.push(chunk, |l| out.push(l.to_owned()));
        out
    }

    /// What is left once the stream ended: a last line without a newline (readline gives it too).
    pub fn end(&mut self) -> Option<String> {
        if self.rest.is_empty() {
            return None;
        }
        let rest = std::mem::take(&mut self.rest);
        let mut out = None;
        emit(&rest, &mut |l: &str| out = Some(l.to_owned()));
        out
    }
}

fn emit(line: &[u8], f: &mut impl FnMut(&str)) {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    match std::str::from_utf8(line) {
        Ok(s) => f(s),
        Err(_) => f(&String::from_utf8_lossy(line)),
    }
}

/// The first `needle` in `hay` (a plain loop: the compiler vectorises it, and no dependency is needed).
fn memchr(needle: u8, hay: &[u8]) -> Option<usize> {
    hay.iter().position(|&b| b == needle)
}

/// One stream-json line as a value, or None for a blank or non-JSON line (v1 skipped both).
pub fn json_line(line: &str) -> Option<Value> {
    if !crate::js::has_text(line) {
        return None;
    }
    serde_json::from_str(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_across_chunks_and_characters() {
        let text = "a\r\nb😀c\n\nlast";
        let bytes = text.as_bytes();
        // Every split point, including inside the emoji.
        for cut in 0..=bytes.len() {
            let mut s = LineSplitter::new();
            let mut got = s.lines(&bytes[..cut]);
            got.extend(s.lines(&bytes[cut..]));
            got.extend(s.end());
            assert_eq!(got, ["a", "b😀c", "", "last"], "cut at {cut}");
        }
    }

    #[test]
    fn json_lines_skip_noise() {
        assert!(json_line("  ").is_none());
        assert!(json_line("not json").is_none());
        assert_eq!(
            json_line(r#"{"a":1}"#).map(|v| v["a"].clone()),
            Some(serde_json::json!(1))
        );
    }
}
