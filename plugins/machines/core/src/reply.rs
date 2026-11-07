//! A peer's HTTP answer as JSON. An error page that isn't JSON (a proxy's 413, a gateway's 502) keeps
//! its words as the error, so the user sees them instead of a JSON parse error (edge case Machines 7).
use serde_json::{Value, json};

pub fn parse_reply(body: &[u8]) -> Value {
    if body.iter().all(u8::is_ascii_whitespace) {
        return json!({});
    }
    serde_json::from_slice(body).unwrap_or_else(|_| {
        let text = String::from_utf8_lossy(body);
        json!({ "error": text.chars().take(200).collect::<String>() })
    })
}

/// The error a peer answered with: its `error`, else `<name>: HTTP <status>`; and its `hold`.
pub fn reply_error(name: &str, status: u16, reply: &Value) -> (String, Option<Value>) {
    let msg = reply
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map_or_else(|| format!("{name}: HTTP {status}"), str::to_owned);
    (msg, reply.get("hold").cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_json_keeps_its_words() {
        assert_eq!(
            parse_reply(b"Request Entity Too Large"),
            json!({"error": "Request Entity Too Large"})
        );
        assert_eq!(parse_reply(b""), json!({}));
        assert_eq!(parse_reply(b"{\"ok\":true}"), json!({"ok": true}));
        let long = "x".repeat(500);
        assert_eq!(
            parse_reply(long.as_bytes())["error"].as_str().map(str::len),
            Some(200)
        );
        assert_eq!(
            reply_error("box", 500, &json!({"error": "disk full over there"})),
            ("disk full over there".into(), None)
        );
        assert_eq!(
            reply_error("box", 502, &json!({})),
            ("box: HTTP 502".into(), None)
        );
        assert_eq!(
            reply_error("box", 409, &json!({"error": "near", "hold": {"until": 1}})).1,
            Some(json!({"until": 1}))
        );
    }
}
