//! LSP's base protocol: a header block (`Content-Length: N`, CRLF-ended, a blank line), then N bytes of
//! JSON. The decoder takes bytes as the pipe delivers them, in any split, and yields whole bodies.

use serde_json::Value;

const SEP: &[u8] = b"\r\n\r\n";

/// Incremental frame decoder. Keeps only the bytes of the frame not yet complete.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
    /// where the next frame starts in `buf` (consumed bytes are dropped in one go, not per frame)
    at: usize,
    /// the body length of the frame at `at`, once its header has been read
    want: Option<(usize, usize)>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds bytes and returns every body completed by them, in order.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(body) = self.next_body() {
            out.push(body);
        }
        // Compact once per push: frames are drained without shifting the buffer each time.
        if self.at > 0 {
            self.buf.drain(..self.at);
            if let Some((start, len)) = self.want {
                self.want = Some((start - self.at, len));
            }
            self.at = 0;
        }
        out
    }

    /// Bytes held for a frame that isn't complete yet.
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.at
    }

    fn next_body(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some((start, len)) = self.want {
                if self.buf.len() < start + len {
                    return None;
                }
                self.want = None;
                self.at = start + len;
                return Some(self.buf[start..start + len].to_vec());
            }
            let rest = &self.buf[self.at..];
            let head = find(rest, SEP)?;
            let body_start = self.at + head + SEP.len();
            match content_length(&rest[..head]) {
                Some(len) => self.want = Some((body_start, len)),
                // A header block without a length can't be framed: skip it rather than stall forever
                // (v1 waited on it and the server went quiet for good).
                None => self.at = body_start,
            }
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `Content-Length: N`, the name in any case, spaces after the colon (v1: /Content-Length: *(\d+)/i).
fn content_length(head: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(head);
    text.split("\r\n").find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("content-length") {
            return None;
        }
        let digits: String = value.trim_start().chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    })
}

/// One message on the wire: `jsonrpc: "2.0"` added, framed.
pub fn encode(msg: &Value) -> Vec<u8> {
    let mut msg = msg.clone();
    if let Value::Object(map) = &mut msg {
        map.insert("jsonrpc".into(), Value::from("2.0"));
    }
    let body = msg.to_string();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrng::Rng;
    use serde_json::json;

    fn stream(msgs: &[Value]) -> Vec<u8> {
        msgs.iter().flat_map(encode).collect()
    }

    fn decode_all(chunks: &[&[u8]]) -> Vec<Value> {
        let mut d = Decoder::new();
        chunks.iter().flat_map(|c| d.push(c)).filter_map(|b| serde_json::from_slice(&b).ok()).collect()
    }

    #[test]
    fn one_frame() {
        let bytes = encode(&json!({ "id": 1, "result": null }));
        assert!(bytes.starts_with(b"Content-Length: "));
        assert_eq!(decode_all(&[&bytes]), vec![json!({ "jsonrpc": "2.0", "id": 1, "result": null })]);
    }

    #[test]
    fn header_name_in_any_case_and_extra_headers() {
        let body = br#"{"id":2}"#;
        let mut bytes = format!("content-type: application/vscode-jsonrpc\r\ncontent-length:  {}\r\n\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(body);
        assert_eq!(decode_all(&[&bytes]), vec![json!({ "id": 2 })]);
    }

    #[test]
    fn a_header_without_a_length_is_skipped() {
        let mut bytes = b"X-Nothing: 1\r\n\r\n".to_vec();
        bytes.extend(encode(&json!({ "id": 3 })));
        assert_eq!(decode_all(&[&bytes]).len(), 1);
    }

    #[test]
    fn multibyte_bodies_are_measured_in_bytes() {
        let msg = json!({ "message": "That file isn’t here — ünïcödé 🦀" });
        assert_eq!(
            decode_all(&[&stream(std::slice::from_ref(&msg))]),
            vec![json!({ "jsonrpc": "2.0", "message": "That file isn’t here — ünïcödé 🦀" })]
        );
    }

    #[test]
    fn nothing_until_complete() {
        let bytes = encode(&json!({ "id": 9 }));
        let mut d = Decoder::new();
        assert_eq!(d.push(&bytes[..bytes.len() - 1]).len(), 0);
        assert_eq!(d.buffered(), bytes.len() - 1);
        assert_eq!(d.push(&bytes[bytes.len() - 1..]).len(), 1);
        assert_eq!(d.buffered(), 0);
    }

    /// Property: any split of the byte stream yields the same messages, in order.
    #[test]
    fn any_split_gives_the_same_messages() {
        let mut rng = Rng::new(0x15b);
        for round in 0..300 {
            let n = 1 + rng.below(6);
            let msgs: Vec<Value> = (0..n).map(|i| json!({ "id": i, "text": "é".repeat(rng.below(40)), "round": round })).collect();
            let bytes = stream(&msgs);
            let mut chunks: Vec<&[u8]> = Vec::new();
            let mut at = 0;
            while at < bytes.len() {
                let len = 1 + rng.below(bytes.len() - at);
                chunks.push(&bytes[at..at + len]);
                at += len;
            }
            let want: Vec<Value> = msgs
                .iter()
                .map(|m| {
                    let mut m = m.clone();
                    m["jsonrpc"] = json!("2.0");
                    m
                })
                .collect();
            assert_eq!(decode_all(&chunks), want, "round {round}");
        }
    }

    #[test]
    fn byte_at_a_time() {
        let msgs: Vec<Value> = (0..20).map(|i| json!({ "id": i })).collect();
        let bytes = stream(&msgs);
        let chunks: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(decode_all(&chunks).len(), 20);
    }
}
