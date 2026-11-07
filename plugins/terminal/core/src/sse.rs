//! The event stream a page reads a terminal from, written exactly as v1 wrote it:
//! `hello` (start over at this size), `data` (output, a JSON string), `exit` ({code}), `gone` (no such
//! terminal: stop reconnecting), and a `: ping` comment every 25 s.

use serde::Serialize;
use serde_json::json;
use wisp_terminal_api::TermState;

/// Keeps proxies (a machine's tunnel, the grid's edge) from timing the stream out.
pub const PING_MS: u64 = 25_000;
pub const PING: &[u8] = b": ping\n\n";
pub const GONE: &[u8] = b"event: gone\ndata: {}\n\n";

/// `event: <name>\ndata: <json>\n\n`
pub fn frame(event: &str, data: &impl Serialize) -> Vec<u8> {
    let data = serde_json::to_string(data).unwrap_or_else(|_| "null".to_owned());
    format!("event: {event}\ndata: {data}\n\n").into_bytes()
}

/// `ordered`: numbered input goes in in order, so the page needn't wait between sends. `state` is v2's
/// (additive: v1 pages read the rest).
pub fn hello(cols: u16, rows: u16, resizable: bool, state: TermState) -> Vec<u8> {
    frame("hello", &json!({ "cols": cols, "rows": rows, "resizable": resizable, "ordered": true, "state": state }))
}

pub fn data(text: &str) -> Vec<u8> {
    frame("data", &text)
}

pub fn exit(code: Option<i32>) -> Vec<u8> {
    frame("exit", &json!({ "code": code }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(b: &[u8]) -> String {
        String::from_utf8_lossy(b).into_owned()
    }

    #[test]
    fn frames_as_v1_wrote_them() {
        assert_eq!(s(&hello(90, 33, true, TermState::Starting)), "event: hello\ndata: {\"cols\":90,\"rows\":33,\"resizable\":true,\"ordered\":true,\"state\":\"starting\"}\n\n");
        assert_eq!(s(&data("")), "event: data\ndata: \"\"\n\n", "an empty replay is still sent");
        assert_eq!(s(&data("oops\r\n\u{1b}[0m")), "event: data\ndata: \"oops\\r\\n\\u001b[0m\"\n\n");
        assert_eq!(s(&exit(Some(0))), "event: exit\ndata: {\"code\":0}\n\n");
        assert_eq!(s(GONE), "event: gone\ndata: {}\n\n");
    }

    /// Property: whatever a program prints, a data frame is one SSE event (no raw newline inside its
    /// data line), so a page never reads half a frame as the next one.
    #[test]
    fn a_data_frame_is_one_event_whatever_was_printed() {
        let mut rng = crate::testrand::Rng::new(11);
        for _ in 0..500 {
            let text: String = (0..rng.below(40)).map(|_| *rng.pick(&['a', '\n', '\r', '"', '\\', '\u{1b}', '✓', ' ', '\0'])).collect();
            let f = s(&data(&text));
            let body = f.strip_prefix("event: data\ndata: ").and_then(|x| x.strip_suffix("\n\n")).unwrap_or_default();
            assert!(!body.contains('\n') && !body.contains('\r'));
            assert_eq!(serde_json::from_str::<String>(body).ok().as_deref(), Some(text.as_str()));
        }
    }
}
