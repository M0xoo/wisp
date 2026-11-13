//! SSE decoding (WHATWG server-sent events), sans-IO: bytes in, events out. Chunks may split
//! anywhere: inside a line, between CR and LF, inside a UTF-8 sequence. LF, CR and CRLF all end a
//! line; a leading BOM is skipped; `id:` persists across events, as the spec says.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// the last `id:` seen on the stream so far
    pub id: Option<String>,
    pub event: String,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    /// bytes of a line not ended yet (kept as bytes: a UTF-8 sequence may be split)
    line: Vec<u8>,
    pending_cr: bool,
    started: bool,
    event: String,
    data: Vec<String>,
    id: Option<String>,
    /// bytes taken so far (the bench counts them)
    pub bytes: u64,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_event_id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.bytes += chunk.len() as u64;
        let mut chunk = chunk;
        if !self.started && !chunk.is_empty() {
            self.started = true;
            chunk = chunk.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(chunk);
        }
        let mut out = Vec::new();
        for &b in chunk {
            if b == b'\n' && self.pending_cr {
                self.pending_cr = false; // the LF of a CRLF
                continue;
            }
            self.pending_cr = b == b'\r';
            if b == b'\n' || b == b'\r' {
                let line = std::mem::take(&mut self.line);
                self.on_line(&String::from_utf8_lossy(&line), &mut out);
            } else {
                self.line.push(b);
            }
        }
        out
    }

    fn on_line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                let event = if self.event.is_empty() { "message".to_owned() } else { std::mem::take(&mut self.event) };
                out.push(SseEvent { id: self.id.clone(), event, data: self.data.join("\n") });
            }
            self.data.clear();
            self.event.clear();
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = line.split_once(':').map_or((line, ""), |(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)));
        match field {
            "data" => self.data.push(value.to_owned()),
            "event" => value.clone_into(&mut self.event),
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_anywhere() {
        let stream = "\u{feff}: hb\n\nid: 7\nevent: sync\ndata: [1,\ndata: 2]\n\nevent: summary\r\ndata: {\"id\":\"é\"}\r\n\r\n";
        let bytes = stream.as_bytes();
        let whole = SseParser::new().push(bytes);
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[0], SseEvent { id: Some("7".into()), event: "sync".into(), data: "[1,\n2]".into() });
        assert_eq!(whole[1], SseEvent { id: Some("7".into()), event: "summary".into(), data: "{\"id\":\"é\"}".into() });
        // every split point gives the same events (a CRLF across chunks, a UTF-8 sequence cut)
        for cut in 0..bytes.len() {
            let mut p = SseParser::new();
            let mut got = p.push(&bytes[..cut]);
            got.extend(p.push(&bytes[cut..]));
            assert_eq!(got, whole, "cut at {cut}");
        }
    }

    #[test]
    fn a_lone_cr_ends_a_line_and_data_without_a_blank_line_waits() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: a\r").is_empty());
        assert_eq!(p.push(b"\r").len(), 1);
        assert!(p.push(b"data: b\n").is_empty());
        assert_eq!(p.bytes, 17); // every byte pushed: 8 + 1 + 8
    }
}
