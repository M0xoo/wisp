//! What a terminal printed, kept so a page that opens later sees the screen (v1 pty.js `keep()`), and
//! the UTF-8 decoding of its output stream.
//!
//! Chunks are joined and cut to the limit only when read or when twice too long: cutting on every chunk
//! copied the whole megabyte each time (v1 learnt this). The limit is in bytes; the cut always lands
//! on a character boundary.

/// Bytes of output replayed to a page that attaches later.
pub const KEEP: usize = 1 << 20;
/// How far past the cut to look for a line or an escape sequence to start the replay at.
const NEAR: usize = 4096;

#[derive(Debug)]
pub struct Replay {
    chunks: Vec<String>,
    kept: usize,
    limit: usize,
}

impl Default for Replay {
    fn default() -> Self {
        Self::new(KEEP)
    }
}

impl Replay {
    pub fn new(limit: usize) -> Self {
        Self {
            chunks: Vec::new(),
            kept: 0,
            limit,
        }
    }

    pub fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.chunks.push(text.to_owned());
        self.kept += text.len();
        if self.kept > 2 * self.limit {
            self.compact();
        }
    }

    /// Everything kept, at most `limit` bytes. Cut at the start of a line or an escape sequence near the
    /// limit, so a replay doesn't begin with half of one printed as text.
    pub fn read(&mut self) -> &str {
        self.compact();
        self.chunks.first().map_or("", String::as_str)
    }

    fn compact(&mut self) {
        let mut out = if self.chunks.len() == 1 {
            self.chunks.pop().unwrap_or_default()
        } else {
            self.chunks.concat()
        };
        if out.len() > self.limit {
            out = out.split_off(cut_at(&out, out.len() - self.limit));
        }
        self.kept = out.len();
        self.chunks.clear();
        if !out.is_empty() {
            self.chunks.push(out);
        }
    }
}

/// Where a replay of `s` cut near `from` starts: after a newline or at an ESC within `NEAR` bytes of
/// it, else the first character boundary at or after it.
fn cut_at(s: &str, from: usize) -> usize {
    let b = s.as_bytes();
    let end = (from + NEAR).min(b.len());
    match b
        .get(from..end)
        .and_then(|w| w.iter().position(|&c| c == b'\n' || c == 0x1b))
    {
        Some(i) if b.get(from + i) == Some(&b'\n') => from + i + 1,
        Some(i) => from + i,
        None => (from..=s.len())
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(s.len()),
    }
}

/// A streaming UTF-8 decoder (v1's `StringDecoder`): a character split across two reads is held until
/// its rest comes; bytes that can never be UTF-8 become U+FFFD.
#[derive(Debug, Default)]
pub struct Utf8Stream {
    tail: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut rest: &[u8] = &buf;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (good, bad) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(good).unwrap_or_default());
                    // None: an unfinished character at the end: wait for the next read
                    let Some(n) = e.error_len() else {
                        self.tail = bad.to_vec();
                        break;
                    };
                    out.push('\u{FFFD}');
                    rest = bad.get(n..).unwrap_or_default();
                }
            }
        }
        out
    }

    /// The end of the stream: an unfinished character is U+FFFD.
    pub fn finish(&mut self) -> String {
        if self.tail.is_empty() {
            String::new()
        } else {
            self.tail.clear();
            "\u{FFFD}".to_owned()
        }
    }
}

/// stderr off a pipe goes on a terminal screen: its bare newlines become CRLF (v1 pty.js).
pub fn crlf(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut prev_cr = false;
    for c in text.chars() {
        if c == '\n' && !prev_cr {
            out.push('\r');
        }
        prev_cr = c == '\r';
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // v1 test/pty.test.js "output is kept to its limit" (the replay part), 1:1.
    #[test]
    fn past_the_limit_it_cuts_at_an_escape_or_a_line() {
        let mut r = Replay::default();
        r.push("38;5;1mtext");
        r.push(&format!("\x1b[31mzz\r\n{}", "x".repeat(KEEP - 12)));
        assert!(r.read().starts_with("\x1b[31mzz\r\nxx"));
        for _ in 0..3000 {
            r.push(&format!("{}\n", "y".repeat(999)));
        }
        let out = r.read();
        assert!(out.len() <= KEEP && out.starts_with('y') && out.ends_with("y\n"));
    }

    #[test]
    fn it_never_holds_more_than_twice_the_limit() {
        let mut r = Replay::new(100);
        for _ in 0..1000 {
            r.push("0123456789");
            assert!(r.kept <= 200 + 10);
        }
        assert_eq!(
            r.read().len(),
            100,
            "no line or escape near: exactly the last 100 bytes"
        );
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        let mut r = Replay::new(10);
        r.push(&"é".repeat(20)); // 2 bytes each: the cut lands mid-character
        let out = r.read().to_owned();
        assert!(out.chars().all(|c| c == 'é') && out.len() <= 10);
        assert_eq!(
            Replay::default().read(),
            "",
            "nothing printed: an empty replay"
        );
    }

    #[test]
    fn utf8_split_across_reads_is_held() {
        let mut d = Utf8Stream::new();
        let bytes = "a✓b".as_bytes();
        assert_eq!(d.decode(&bytes[..2]), "a");
        assert_eq!(d.decode(&bytes[2..4]), "✓");
        assert_eq!(d.decode(&bytes[4..]), "b");
        assert_eq!(d.decode(&[0xff, b'x']), "\u{FFFD}x");
        assert_eq!(d.decode(&[0xe2]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
        assert_eq!(d.finish(), "");
    }

    /// Property: however the stream is split, decoding it piece by piece gives the whole text.
    #[test]
    fn any_split_decodes_the_same() {
        let mut rng = crate::testrand::Rng::new(7);
        let text = "plain, ✓ ticks, é and 🦀 crabs\r\n".repeat(20);
        let bytes = text.as_bytes();
        for _ in 0..300 {
            let mut d = Utf8Stream::new();
            let (mut out, mut at) = (String::new(), 0);
            while at < bytes.len() {
                let n = (1 + rng.below(7)).min(bytes.len() - at);
                out.push_str(&d.decode(&bytes[at..at + n]));
                at += n;
            }
            out.push_str(&d.finish());
            assert_eq!(out, text);
        }
    }

    #[test]
    fn stderr_newlines_become_crlf_once() {
        assert_eq!(crlf("oops\n"), "oops\r\n");
        assert_eq!(crlf("a\r\nb\nc"), "a\r\nb\r\nc");
    }
}
