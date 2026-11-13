//! Testing a connector (v1 `probe`): start it through the proxy, the way an agent would, and list its
//! tools. This is the conversation as a state machine; the host feeds it the proxy's stdout lines,
//! its stderr, its exit and the timeout.

use serde_json::{Value, json};
use wisp_connectors_api::ProbeResult;

use crate::text::{capitalize, clip};

/// npx may download the server first.
pub const PROBE_MS: u64 = 60_000;
/// Stderr kept for the reason (the last of it).
pub const STDERR_KEEP: usize = 4000;
/// A long list comes in pages; three are plenty to show.
const LAST_PAGE_ID: i64 = 4;
const SHOWN: usize = 200;

/// What the host does after a line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Step {
    /// lines to send to the proxy
    pub send: Vec<String>,
    /// the answer: stop the proxy and keep it
    pub done: Option<Outcome>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Ok {
        tools: Vec<String>,
        count: u32,
    },
    /// the fallback reason (stderr's tail wins over it when there is one)
    Failed(String),
}

#[derive(Debug)]
pub struct Probe {
    name: String,
    tools: Vec<String>,
    stderr: String,
}

fn line(v: &Value) -> String {
    v.to_string()
}

impl Probe {
    pub fn new(name: &str) -> Self {
        Self { name: name.to_owned(), tools: Vec::new(), stderr: String::new() }
    }

    /// The row already names it: "wisp: " and "<name>: " in front say nothing more.
    pub fn tidy(&self, t: &str) -> String {
        let t = t.strip_prefix("wisp: ").unwrap_or(t);
        capitalize(&t.replacen(&format!("{}: ", self.name), "", 1))
    }

    pub fn stderr(&mut self, text: &str) {
        self.stderr.push_str(text);
        self.stderr.push('\n');
        let len = self.stderr.len();
        if len > STDERR_KEEP {
            let mut cut = len - STDERR_KEEP;
            while !self.stderr.is_char_boundary(cut) {
                cut += 1;
            }
            self.stderr.drain(..cut);
        }
    }

    fn error_of(&self, m: &Value, fallback: &str) -> Outcome {
        let msg = m.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(fallback);
        Outcome::Failed(self.tidy(msg))
    }

    /// A line from the proxy's stdout.
    pub fn on_line(&mut self, text: &str) -> Step {
        let Ok(m) = serde_json::from_str::<Value>(text) else { return Step::default() };
        let id = m.get("id").and_then(Value::as_i64);
        match id {
            Some(1) => {
                if m.get("error").is_some() {
                    return Step { send: Vec::new(), done: Some(self.error_of(&m, "It refused to start")) };
                }
                let send = vec![
                    line(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
                    line(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })),
                ];
                Step { send, done: None }
            }
            Some(n) if n >= 2 => {
                if m.get("error").is_some() {
                    return Step { send: Vec::new(), done: Some(self.error_of(&m, "It wouldn’t list its tools")) };
                }
                let result = m.get("result");
                let names = result
                    .and_then(|r| r.get("tools"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t.get("name")?.as_str().filter(|s| !s.is_empty()));
                self.tools.extend(names.map(str::to_owned));
                match result.and_then(|r| r.get("nextCursor")).filter(|c| !c.is_null() && *c != "") {
                    Some(cursor) if n < LAST_PAGE_ID => Step {
                        send: vec![line(&json!({ "jsonrpc": "2.0", "id": n + 1, "method": "tools/list", "params": { "cursor": cursor } }))],
                        done: None,
                    },
                    _ => Step {
                        send: Vec::new(),
                        done: Some(Outcome::Ok {
                            tools: self.tools.iter().take(SHOWN).cloned().collect(),
                            count: u32::try_from(self.tools.len()).unwrap_or(u32::MAX),
                        }),
                    },
                }
            }
            _ if crate::rpc::is_request(&m) => {
                // the server asks something of the client: wisp only lists tools
                let id = m.get("id").cloned().unwrap_or(Value::Null);
                Step {
                    send: vec![line(
                        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "wisp is only listing tools" } }),
                    )],
                    done: None,
                }
            }
            _ => Step::default(),
        }
    }

    /// The row's result. A failure says the last of stderr (up to three lines) or the fallback; one
    /// refused for want of a sign-in is marked `auth`, and the row offers Sign in.
    pub fn result(&self, outcome: Outcome, at: i64) -> ProbeResult {
        match outcome {
            Outcome::Ok { tools, count } => ProbeResult { at, ok: true, tools: Some(tools), count: Some(count), error: None, auth: false },
            Outcome::Failed(fallback) => {
                let lines: Vec<&str> = self.stderr.trim().lines().filter(|l| !l.is_empty()).collect();
                let tail = lines[lines.len().saturating_sub(3)..].join(" · ");
                let error = clip(&self.tidy(if tail.is_empty() { &fallback } else { &tail }), 300);
                let lower = error.to_lowercase();
                let auth = lower.contains("needs sign-in") || lower.contains("http 401") || lower.contains("http 403");
                ProbeResult { at, ok: false, tools: None, count: None, error: Some(error), auth }
            }
        }
    }
}

pub const TIMEOUT_REASON: &str = "It didn’t answer within a minute";

pub fn exited_reason(code: i32) -> String {
    format!("It stopped before answering (exit {code})")
}
