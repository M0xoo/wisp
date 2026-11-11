//! The gateway (v1 discord.js `#listen`, `#identify`, `#dispatch`): one connection's frames in, what the host must do
//! out. A hello sets the beat; the first beat goes after a jittered part of it; a beat whose ack never came ends the
//! socket (a laptop that slept leaves one that looks open). With a session, a resume; else an identify.

use serde_json::{Value, json};

use crate::INTENTS;

pub const HEARTBEAT: u64 = 1;
pub const IDENTIFY: u64 = 2;
pub const RESUME: u64 = 6;
const DISPATCH: u64 = 0;
const RECONNECT: u64 = 7;
const INVALID: u64 = 9;
const HELLO: u64 = 10;
const ACK: u64 = 11;

/// What a resume needs, kept across connections.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub url: String,
    pub seq: Option<i64>,
}

/// Who this bot is (READY).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Me {
    pub id: String,
    pub name: String,
    pub app_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Send(String),
    /// the beat's interval, ms: the first beat after a part of it
    Beat(u64),
    Ready(Me),
    Resumed,
    /// a person's message (`MESSAGE_CREATE`'s `d`)
    Message(Value),
    /// `/wisp`, a keystroke in it, or a press on a button (`INTERACTION_CREATE`'s `d`)
    Interaction(Value),
    /// close now; `again`: Discord asked for a new connection; `wait_ms`: not before this
    Close { again: bool, wait_ms: u64 },
}

/// One connection's state, plus the session it may resume.
#[derive(Debug, Clone, Default)]
pub struct Conn {
    pub session: Option<Session>,
    acked: bool,
    pub token: String,
    pub os: String,
}

pub fn op(op: u64, d: &Value) -> String {
    json!({ "op": op, "d": d }).to_string()
}

impl Conn {
    pub fn new(token: &str, session: Option<Session>) -> Self {
        Self { session, acked: true, token: token.to_owned(), os: std::env::consts::OS.to_owned() }
    }

    fn seq(&self) -> Option<i64> {
        self.session.as_ref().and_then(|s| s.seq)
    }

    /// The beat is due: send it, or None when the last one was never acked (the socket is gone).
    pub fn beat(&mut self) -> Option<String> {
        if !self.acked {
            return None;
        }
        self.acked = false;
        Some(op(HEARTBEAT, &json!(self.seq())))
    }

    /// `invalid_ms`: what Discord asks to wait after an invalid session (1 to 5 s; the host picks).
    pub fn frame(&mut self, text: &str, invalid_ms: u64) -> Vec<Step> {
        let Ok(m) = serde_json::from_str::<Value>(text) else { return Vec::new() };
        let code = m["op"].as_u64().unwrap_or(u64::MAX);
        match code {
            HELLO => {
                let every = m["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250);
                let hello = match &self.session {
                    Some(s) => op(RESUME, &json!({ "token": self.token, "session_id": s.id, "seq": s.seq })),
                    None => op(IDENTIFY, &json!({ "token": self.token, "intents": INTENTS, "properties": { "os": self.os, "browser": "wisp", "device": "wisp" } })),
                };
                vec![Step::Beat(every), Step::Send(hello)]
            }
            ACK => {
                self.acked = true;
                Vec::new()
            }
            HEARTBEAT => vec![Step::Send(op(HEARTBEAT, &json!(self.seq())))],
            RECONNECT => vec![Step::Close { again: true, wait_ms: 0 }],
            INVALID => {
                if m["d"] != true {
                    self.session = None;
                }
                vec![Step::Close { again: false, wait_ms: invalid_ms }]
            }
            DISPATCH => {
                if let (Some(n), Some(s)) = (m["s"].as_i64(), self.session.as_mut()) {
                    s.seq = Some(n);
                }
                self.dispatch(m["t"].as_str().unwrap_or_default(), &m["d"], m["s"].as_i64())
            }
            _ => Vec::new(),
        }
    }

    fn dispatch(&mut self, t: &str, d: &Value, seq: Option<i64>) -> Vec<Step> {
        let s = |v: &Value| v.as_str().unwrap_or_default().to_owned();
        match t {
            "READY" => {
                self.session = Some(Session { id: s(&d["session_id"]), url: s(&d["resume_gateway_url"]), seq });
                vec![Step::Ready(Me { id: s(&d["user"]["id"]), name: s(&d["user"]["username"]), app_id: d["application"]["id"].as_str().map(str::to_owned) })]
            }
            "RESUMED" => vec![Step::Resumed],
            "MESSAGE_CREATE" => vec![Step::Message(d.clone())],
            "INTERACTION_CREATE" => vec![Step::Interaction(d.clone())],
            _ => Vec::new(),
        }
    }
}

/// How a close code ends things: a reason it won't come back, and whether the session is over.
pub fn closed(code: u16) -> (Option<&'static str>, bool) {
    let fatal = match code {
        4004 => Some("Discord refused the token. Check the token in wisp → Settings → Phone → Discord."),
        4010 => Some("Discord refused the shard wisp sent. Update wisp."),
        4011 => Some("This bot is in too many servers for one connection: Discord wants sharding, which wisp doesn’t do."),
        4012 => Some("Discord no longer takes this gateway version. Update wisp."),
        4013 => Some("Discord refused the intents wisp asked for. Update wisp."),
        4014 => Some("Discord won’t give this bot the intents it asked for: check them in the Developer Portal → Bot."),
        _ => None,
    };
    (fatal, matches!(code, 1000 | 1001 | 4007 | 4009))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn hello_identifies_or_resumes_and_a_beat_without_its_ack_ends_the_socket() {
        let mut c = Conn::new("tok", None);
        let steps = c.frame(r#"{"op":10,"d":{"heartbeat_interval":45000}}"#, 1000);
        assert_eq!(steps[0], Step::Beat(45_000));
        let Step::Send(id) = &steps[1] else { panic!() };
        let v: Value = serde_json::from_str(id).unwrap();
        assert_eq!((v["op"].as_u64(), v["d"]["intents"].as_u64()), (Some(IDENTIFY), Some(INTENTS)));
        let ready = c.frame(r#"{"op":0,"t":"READY","s":1,"d":{"session_id":"S","resume_gateway_url":"wss://r","user":{"id":"B","username":"wisp"},"application":{"id":"A"}}}"#, 0);
        assert_eq!(ready, vec![Step::Ready(Me { id: "B".into(), name: "wisp".into(), app_id: Some("A".into()) })]);
        assert_eq!(c.session.as_ref().map(|s| (s.id.as_str(), s.seq)), Some(("S", Some(1))));
        c.frame(r#"{"op":0,"t":"MESSAGE_CREATE","s":7,"d":{}}"#, 0);
        assert_eq!(c.beat().map(|b| serde_json::from_str::<Value>(&b).unwrap()["d"].clone()), Some(json!(7)), "the beat carries the last seq");
        assert_eq!(c.beat(), None, "no ack since the last beat: gone");
        c.frame(r#"{"op":11}"#, 0);
        assert!(c.beat().is_some());
        let mut again = Conn::new("tok", c.session.clone());
        let Step::Send(r) = &again.frame(r#"{"op":10,"d":{"heartbeat_interval":1}}"#, 0)[1] else { panic!() };
        assert!(r.contains(r#""op":6"#) && r.contains(r#""session_id":"S""#), "a session resumes");
        assert_eq!(again.frame(r#"{"op":9,"d":false}"#, 2500), vec![Step::Close { again: false, wait_ms: 2500 }]);
        assert!(again.session.is_none(), "not resumable: identify next time");
        assert_eq!(again.frame(r#"{"op":7}"#, 0), vec![Step::Close { again: true, wait_ms: 0 }]);
        assert_eq!(closed(4004).0.map(|f| f.contains("token")), Some(true));
        assert_eq!(closed(4009), (None, true));
        assert_eq!(closed(1006), (None, false));
    }
}
