//! Topics: what a client subscribes to (plan §4.3). A `Topic` is checked when it is made, so every
//! one inside the server is valid; cloning it is a reference count, since each change row's topic is
//! copied into every connection's outbox.

use std::fmt;
use std::sync::Arc;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// `list` · `config` · `crew` · `machines` · `stuff` · `session:<id>` · `plugin:<id>:<topic>`.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, ts_rs::TS)]
#[ts(
    type = "'list' | 'config' | 'crew' | 'machines' | 'stuff' | `session:${string}` | `plugin:${string}:${string}`"
)]
pub struct Topic(Arc<str>);

/// Topics every wisp has; the rest are `session:<id>` and `plugin:<id>:<topic>`.
const FIXED: [&str; 5] = ["list", "config", "crew", "machines", "stuff"];

impl Topic {
    /// The topic, when `s` is one (the same rule as `isTopic` in @wisp/protocol).
    pub fn parse(s: &str) -> Option<Self> {
        is_topic(s).then(|| Self(Arc::from(s)))
    }

    /// `session:<id>` for a session id; `None` when the id is empty or has whitespace.
    pub fn session(id: &str) -> Option<Self> {
        Self::parse(&format!("session:{id}"))
    }

    /// The `list` topic.
    pub fn list() -> Self {
        Self(Arc::from("list"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `session:<id>` topics: the open transcripts, the client's first priority after acks.
    pub fn is_session(&self) -> bool {
        self.0.starts_with("session:")
    }

    /// Lower goes first (plan §4.4): the client's sessions, then the list, then the rest.
    pub fn rank(&self) -> u8 {
        if self.is_session() {
            1
        } else if &*self.0 == "list" {
            2
        } else {
            3
        }
    }
}

/// The topic grammar: a fixed name, `session:` + no whitespace, `plugin:<id>:<name>` in lowercase.
pub fn is_topic(s: &str) -> bool {
    if FIXED.contains(&s) {
        return true;
    }
    if let Some(id) = s.strip_prefix("session:") {
        return !id.is_empty() && !id.chars().any(char::is_whitespace);
    }
    if let Some(rest) = s.strip_prefix("plugin:") {
        let Some((id, name)) = rest.split_once(':') else {
            return false;
        };
        let ok = |part: &str, extra: &[char]| {
            !part.is_empty()
                && part.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || extra.contains(&c)
                })
        };
        return ok(id, &['.']) && ok(name, &['.', '_']);
    }
    false
}

impl fmt::Debug for Topic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&*self.0, f)
    }
}

impl fmt::Display for Topic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for Topic {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Topic {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
        Self::parse(&s).ok_or_else(|| D::Error::custom(format!("not a topic: {s}")))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_grammar_matches_is_topic_in_typescript() {
        for ok in [
            "list",
            "config",
            "crew",
            "machines",
            "stuff",
            "session:a",
            "session:s-1/x",
            "plugin:wisp.git:status",
            "plugin:acme-x:a_b.c",
        ] {
            assert!(is_topic(ok), "{ok}");
        }
        for bad in [
            "",
            "lists",
            "session:",
            "session:a b",
            "plugin:x",
            "plugin:X:y",
            "plugin::y",
            "plugin:x:",
            "plugin:x:y z",
            "bogus topic",
        ] {
            assert!(!is_topic(bad), "{bad}");
        }
    }

    #[test]
    fn rank_puts_sessions_first() {
        let t = |s: &str| Topic::parse(s).unwrap();
        assert!(t("session:a").rank() < t("list").rank());
        assert!(t("list").rank() < t("machines").rank());
        assert_eq!(serde_json::to_string(&t("list")).unwrap(), "\"list\"");
        assert!(serde_json::from_str::<Topic>("\"nope\"").is_err());
    }
}
