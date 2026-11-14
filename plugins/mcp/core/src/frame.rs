//! Newline-delimited stdio framing, as v1 read it with Node's readline: a line ends at `\n`, `\r\n` or a
//! lone `\r`, the last line counts without one, and blank or unparsable lines are dropped. The host owns
//! the IO; this only cuts bytes into lines.

use crate::rpc::{self, Incoming};
use crate::words;

/// A line longer than this is dropped whole (v1 had no cap; a runaway writer shouldn't take wisp's memory).
pub const MAX_LINE: usize = 64 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct LineFramer {
    buf: Vec<u8>,
    /// the line in progress grew past `MAX_LINE`: skip to its end
    skipping: bool,
    /// the last byte was `\r`: a `\n` right after it ends nothing new
    after_cr: bool,
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds bytes in; returns every line they complete, in order, without its line end.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            let after_cr = std::mem::replace(&mut self.after_cr, b == b'\r');
            match b {
                b'\n' if after_cr => {}
                b'\n' | b'\r' => self.end_line(&mut out),
                _ if self.skipping => {}
                _ => {
                    self.buf.push(b);
                    if self.buf.len() > MAX_LINE {
                        self.buf = Vec::new();
                        self.skipping = true;
                    }
                }
            }
        }
        out
    }

    /// The input closed: the line in progress, if any (readline emits it too).
    pub fn finish(&mut self) -> Option<String> {
        let mut out = Vec::new();
        self.end_line(&mut out);
        out.pop()
    }

    fn end_line(&mut self, out: &mut Vec<String>) {
        if !std::mem::take(&mut self.skipping) && !self.buf.is_empty() {
            out.push(String::from_utf8_lossy(&self.buf).into_owned());
        }
        self.buf.clear();
    }
}

/// Is this line worth sending on? Blank or not JSON: v1 dropped it.
pub fn worth_sending(line: &str) -> bool {
    !line.trim().is_empty() && !matches!(rpc::parse(line), Incoming::Nothing)
}

/// What the stdio bridge answers when wisp can't (refused the token, or gone): v1's words per tool, so a
/// question reads as unanswered and the permission gate fails closed. `None` for a notification.
pub fn gone_answer(line: &str, why: &str) -> Option<String> {
    let mut lines = Vec::new();
    match rpc::parse(line) {
        Incoming::One(m) => lines.extend(gone_one(&m, why)),
        Incoming::Batch(items) => lines.extend(items.iter().flatten().filter_map(|m| gone_one(m, why))),
        Incoming::Nothing => {}
    }
    match lines.len() {
        0 => None,
        1 => lines.pop(),
        _ => rpc::batch(&lines),
    }
}

fn gone_one(m: &rpc::Message, why: &str) -> Option<String> {
    let id = m.id.as_deref()?;
    let tool = if m.method() == Some("tools/call") { m.tool().unwrap_or("") } else { "" };
    let body = match tool {
        "ask_user" => rpc::tool_text(words::ASK_CANCELLED, false),
        "approve" => rpc::tool_text(&words::deny_json(&format!("{}: {why}", words::NO_USER)), false),
        _ => rpc::tool_text(&format!("wisp: {why}"), true),
    };
    Some(rpc::result(id, &body))
}
