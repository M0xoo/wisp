//! What goes to ntfy and what comes back: the publish body with its signed buttons, the poll's
//! newline-delimited JSON, and a tap's signed answer.
use serde::Deserialize;
use serde_json::{Value, json};
use wisp_channels_api::{Action, Msg, Signed};

use crate::config::Where;
use crate::truncate;

pub const ACTIONS_MAX: usize = 3;
const LABEL_MAX: usize = 40;
const TITLE_MAX: usize = 200;
const TEXT_MAX: usize = 3000;

/// Where a tap's answer goes, and where wisp polls it from.
pub fn reply_url(w: &Where) -> String {
    format!("{}/{}-reply", w.server, w.topic)
}

pub fn poll_url(w: &Where, since: &str) -> String {
    // since is digits or an ntfy id (letters and digits): nothing to escape
    let since: String = since.chars().filter(char::is_ascii_alphanumeric).collect();
    format!("{}/json?poll=1&since={since}", reply_url(w))
}

/// The JSON posted to the server's root. Buttons only about a task, at most 3; each POSTs
/// `{ s, k, r, i, sig }` to `<topic>-reply`, signed by the hub over all four.
pub fn publish_body(w: &Where, msg: &Msg, session: Option<&str>, sign: &dyn Fn(&str, &Action) -> String) -> Value {
    let headers: serde_json::Map<String, Value> = w.headers().into_iter().map(|(k, v)| (k, Value::String(v))).collect();
    let actions: Vec<Value> = session
        .map(|s| {
            msg.actions
                .iter()
                .take(ACTIONS_MAX)
                .map(|a| {
                    let body = json!({ "s": s, "k": a.kind.code(), "r": a.reference, "i": a.index, "sig": sign(s, a) });
                    json!({ "action": "http", "label": truncate(&a.label, LABEL_MAX), "url": reply_url(w), "method": "POST", "headers": headers, "body": body.to_string(), "clear": true })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = json!({ "topic": w.topic, "title": truncate(&msg.title, TITLE_MAX), "message": truncate(&msg.text, TEXT_MAX), "tags": ["wisp"] });
    if !actions.is_empty() {
        out["actions"] = Value::Array(actions);
    }
    out
}

/// One line of a poll.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct PollMsg {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub time: i64,
    #[serde(default)]
    pub message: String,
}

/// The poll's lines, in order. → the messages, and how many lines weren't JSON (a proxy's page, a
/// cut answer): those are skipped, and the caller says so in Settings.
pub fn parse_poll(body: &str) -> (Vec<PollMsg>, usize) {
    let mut bad = 0;
    let msgs = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let m = serde_json::from_str::<PollMsg>(l).ok();
            bad += usize::from(m.is_none());
            m
        })
        .collect();
    (msgs, bad)
}

/// A tap: it says what to do, signed. Anything else on the topic (a message of its own, a keepalive)
/// is `None`. The hub checks the signature; this only reads it.
pub fn parse_tap(m: &PollMsg) -> Option<Signed> {
    if m.event != "message" {
        return None;
    }
    let p: Value = serde_json::from_str(&m.message).ok()?;
    let s = p.get("s")?.as_str()?.to_owned();
    let k = p.get("k")?.as_str()?.to_owned();
    let r = p.get("r")?.as_str()?.to_owned();
    // v1 read `Number(p.i)`: a string of digits is the same index
    let i = match p.get("i")? {
        Value::Number(n) => u32::try_from(n.as_u64()?).ok()?,
        Value::String(t) => t.parse().ok()?,
        _ => return None,
    };
    let sig = p.get("sig")?.as_str()?.to_owned();
    (!s.is_empty() && !sig.is_empty()).then_some(Signed { s, k, r, i, sig })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_channels_api::ActionKind;

    fn place(token: &str) -> Where {
        Where { server: "https://ntfy.sh".into(), topic: "wisp-t".into(), token: token.into() }
    }

    fn act(label: &str, i: u32) -> Action {
        Action { label: label.into(), kind: ActionKind::Answer, reference: "q1".into(), index: i }
    }

    #[test]
    fn buttons_are_signed_and_at_most_three() {
        let msg = Msg { title: "Q".into(), text: "which?".into(), actions: (0..5).map(|i| act(&"x".repeat(50), i)).collect() };
        let sign = |s: &str, a: &Action| format!("sig-{s}-{}", a.index);
        let b = publish_body(&place("tk"), &msg, Some("s1"), &sign);
        let acts = b["actions"].as_array().unwrap();
        assert_eq!(acts.len(), 3);
        assert_eq!(acts[0]["url"], "https://ntfy.sh/wisp-t-reply");
        assert_eq!(acts[0]["headers"]["authorization"], "Bearer tk");
        assert_eq!(acts[0]["label"].as_str().unwrap().chars().count(), 40);
        let body: Value = serde_json::from_str(acts[2]["body"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({ "s": "s1", "k": "a", "r": "q1", "i": 2, "sig": "sig-s1-2" }));
        assert_eq!(b["tags"], json!(["wisp"]));
    }

    #[test]
    fn no_task_no_buttons() {
        let msg = Msg { title: "T".repeat(300), text: "y".repeat(4000), actions: vec![act("ok", 0)] };
        let b = publish_body(&place(""), &msg, None, &|_, _| String::new());
        assert!(b.get("actions").is_none());
        assert_eq!(b["title"].as_str().unwrap().chars().count(), 200);
        assert_eq!(b["message"].as_str().unwrap().chars().count(), 3000);
    }

    #[test]
    fn poll_urls() {
        assert_eq!(poll_url(&place(""), "m2"), "https://ntfy.sh/wisp-t-reply/json?poll=1&since=m2");
        assert_eq!(poll_url(&place(""), "1&x=y"), "https://ntfy.sh/wisp-t-reply/json?poll=1&since=1xy");
    }

    #[test]
    fn polls_skip_what_isnt_json() {
        let (m, bad) = parse_poll("{\"id\":\"m1\",\"event\":\"message\",\"time\":5,\"message\":\"x\"}\n\n<html>\n{\"id\":\"m2\",\"event\":\"keepalive\"}\n");
        assert_eq!(m.len(), 2);
        assert_eq!(bad, 1);
        assert_eq!(m[0].id, "m1");
    }

    #[test]
    fn taps() {
        let m = |event: &str, message: &str| PollMsg { id: "m1".into(), event: event.into(), time: 0, message: message.into() };
        let t = parse_tap(&m("message", r#"{"s":"s1","k":"a","r":"q1","i":0,"sig":"abc"}"#)).unwrap();
        assert_eq!((t.s.as_str(), t.k.as_str(), t.r.as_str(), t.i, t.sig.as_str()), ("s1", "a", "q1", 0, "abc"));
        assert_eq!(parse_tap(&m("message", r#"{"s":"s1","k":"a","r":"q1","i":"2","sig":"abc"}"#)).unwrap().i, 2);
        assert!(parse_tap(&m("keepalive", r#"{"s":"s1","k":"a","r":"q1","i":0,"sig":"abc"}"#)).is_none());
        assert!(parse_tap(&m("message", "hello from someone")).is_none());
        assert!(parse_tap(&m("message", r#"{"s":"s1","k":"a","r":"q1","i":0}"#)).is_none(), "unsigned");
        assert!(parse_tap(&m("message", r#"{"s":"s1","k":"a","r":"q1","i":-1,"sig":"x"}"#)).is_none());
    }

    /// Property: whatever bytes a poll brings, parsing never fails and counts every non-blank line
    /// as a message or a bad line.
    #[test]
    fn property_poll_parsing_is_total() {
        let mut x: u64 = 0xDEAD_BEEF_CAFE_F00D;
        let pieces = ["{\"id\":\"m1\",\"event\":\"message\",\"message\":\"{}\"}", "\n", "{", "}", "\"", "garbage", " ", "{\"id\":3}", "\r\n"];
        for _ in 0..3000 {
            let mut body = String::new();
            for _ in 0..(x % 12) {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                body.push_str(pieces[usize::try_from(x % pieces.len() as u64).unwrap()]);
            }
            x ^= x << 13;
            let (m, bad) = parse_poll(&body);
            assert_eq!(m.len() + bad, body.lines().filter(|l| !l.trim().is_empty()).count());
            for p in &m {
                let _ = parse_tap(p);
            }
        }
    }
}
