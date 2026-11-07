//! `channels.ntfy`'s config, as v1 kept it in `config.remote.ntfy`: the switch, the server, the
//! topic, a token (a secret: in `~/.wisp/secrets.json`), and where reading stopped.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::NtfyError;
use crate::cursor::Cursor;

pub const DEFAULT_SERVER: &str = "https://ntfy.sh";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ntfy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub server: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    /// where reading stopped: a message id, or at first a time in seconds
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub since: String,
    /// the last ids handled, newest last: ntfy hands back since's own second
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seen: Vec<String>,
}

impl Ntfy {
    pub fn from_value(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
    /// configured well enough to send
    pub fn ready(&self) -> bool {
        self.enabled && !self.topic.is_empty()
    }
    pub fn place(&self) -> Where {
        let server = if self.server.is_empty() { DEFAULT_SERVER } else { self.server.as_str() };
        Where { server: server.trim_end_matches('/').to_owned(), topic: self.topic.clone(), token: self.token.clone() }
    }
    pub fn cursor(&self) -> Cursor {
        Cursor::new(self.since.clone(), self.seen.clone())
    }
    /// Writes the cursor's persisted part back.
    pub fn keep(&mut self, c: &Cursor) {
        self.since = c.since().to_owned();
        self.seen = c.kept().to_vec();
    }
    /// Settings' view: the token masked, and where reading stopped isn't shown.
    pub fn view(&self) -> Value {
        json!({ "enabled": self.enabled, "server": self.place().server, "topic": self.topic, "token": mask(&self.token) })
    }
}

/// Where to post and poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Where {
    pub server: String,
    pub topic: String,
    pub token: String,
}

impl Where {
    pub fn headers(&self) -> Vec<(String, String)> {
        if self.token.is_empty() { Vec::new() } else { vec![("authorization".into(), format!("Bearer {}", self.token))] }
    }
}

pub fn mask(t: &str) -> String {
    if t.is_empty() {
        return String::new();
    }
    let tail: Vec<char> = t.chars().rev().take(4).collect();
    format!("••••{}", tail.into_iter().rev().collect::<String>())
}

fn server_ok(s: &str) -> bool {
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.chars().any(char::is_whitespace))
}

fn topic_ok(t: &str) -> bool {
    (1..=64).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A PUT's `ntfy` part over the config (v1 `Remote.update`). A masked or missing token is
/// unchanged. Where reading stopped stays only while it's the same topic on the same server and it
/// stays on: an id means nothing on another topic, and taps sent while it was off weren't for wisp.
pub fn merge_update(prev: &Ntfy, body: &Value) -> Result<Ntfy, NtfyError> {
    let str_of = |k: &str| body.get(k).and_then(Value::as_str).map(str::trim);
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(prev.enabled);
    let server = str_of("server").map_or_else(|| prev.server.clone(), str::to_owned);
    let topic = str_of("topic").map_or_else(|| prev.topic.clone(), str::to_owned);
    let token = match str_of("token") {
        None => prev.token.clone(),
        Some(t) if t.starts_with("••••") => prev.token.clone(),
        Some(t) => t.to_owned(),
    };
    if !server.is_empty() && !server_ok(&server) {
        return Err(NtfyError::Invalid("ntfy server must be an http(s) URL".into()));
    }
    if !topic.is_empty() && !topic_ok(&topic) {
        return Err(NtfyError::Invalid("ntfy topic: letters, digits, - and _ only".into()));
    }
    let server = if server.is_empty() { DEFAULT_SERVER.to_owned() } else { server.trim_end_matches('/').to_owned() };
    let same = enabled && prev.enabled && server == prev.place().server && topic == prev.topic;
    let (since, seen) = if same { (prev.since.clone(), prev.seen.clone()) } else { (String::new(), Vec::new()) };
    Ok(Ntfy { enabled, server, topic, token, since, seen })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> Ntfy {
        Ntfy { enabled: true, server: DEFAULT_SERVER.into(), topic: "wisp-t".into(), token: "tk_old1234".into(), since: "m9".into(), seen: vec!["m9".into()] }
    }

    #[test]
    fn off_by_default() {
        let n = Ntfy::from_value(&Value::Null);
        assert!(!n.ready());
        assert!(!Ntfy { topic: "t".into(), ..Ntfy::default() }.ready());
        assert!(Ntfy { enabled: true, topic: "t".into(), ..Ntfy::default() }.ready());
    }

    #[test]
    fn where_and_view() {
        let n = Ntfy { server: "https://n.example/".into(), ..on() };
        assert_eq!(n.place().server, "https://n.example");
        assert_eq!(n.place().headers(), vec![("authorization".to_owned(), "Bearer tk_old1234".to_owned())]);
        let v = n.view();
        assert_eq!(v["token"], "••••1234");
        assert!(v.get("since").is_none());
        assert_eq!(Ntfy::default().view()["server"], DEFAULT_SERVER);
    }

    #[test]
    fn since_belongs_to_that_topic_on_that_server_while_on() {
        let n = merge_update(&on(), &json!({ "token": "tk_new" })).unwrap();
        assert_eq!((n.since.as_str(), n.token.as_str()), ("m9", "tk_new"), "a new token reads the same topic");
        let n = merge_update(&on(), &json!({ "token": "••••1234" })).unwrap();
        assert_eq!(n.token, "tk_old1234", "masked: unchanged");
        let n = merge_update(&on(), &json!({ "topic": "wisp-other" })).unwrap();
        assert_eq!(n.since, "", "another topic has other ids");
        let n = merge_update(&on(), &json!({ "server": "https://other.example" })).unwrap();
        assert_eq!(n.since, "");
        let n = merge_update(&on(), &json!({ "enabled": false })).unwrap();
        assert!(n.since.is_empty() && n.seen.is_empty(), "off: taps from then on were not meant for it");
        let off = Ntfy { enabled: false, ..on() };
        assert_eq!(merge_update(&off, &json!({ "enabled": true })).unwrap().since, "", "on again starts from now");
    }

    #[test]
    fn refuses_bad_servers_and_topics() {
        assert!(merge_update(&on(), &json!({ "server": "ftp://x" })).is_err());
        assert!(merge_update(&on(), &json!({ "server": "https://a b" })).is_err());
        assert!(merge_update(&on(), &json!({ "topic": "a/b" })).is_err());
        assert!(merge_update(&on(), &json!({ "topic": "x".repeat(65) })).is_err());
        assert!(merge_update(&on(), &json!({ "topic": "ok_topic-1" })).is_ok());
    }

    #[test]
    fn round_trips() {
        assert_eq!(Ntfy::from_value(&on().to_value()), on());
    }
}
