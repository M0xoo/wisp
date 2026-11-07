//! The parts of the Bot API's `Update` wisp reads (<https://core.telegram.org/bots/api#update>).
//! Lenient: a field Telegram adds, or one it leaves out, never fails the whole update.
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// Ids arrive as numbers (chats, users) and are compared as strings, as v1 did: a config written
/// by hand or by an older wisp may hold either.
fn id_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    })
}

fn opt_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let s = id_string(d)?;
    Ok((!s.is_empty()).then_some(s))
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Chat {
    #[serde(default, deserialize_with = "id_string")]
    pub id: String,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

impl Chat {
    /// Only a private chat is one person: in a group anyone there can steer wisp, so no Full auto.
    /// An update without a type goes by the id's sign, as Telegram's are (groups are negative).
    pub fn solo(&self) -> bool {
        match self.kind.as_deref() {
            Some(k) => k == "private",
            None => self.id.parse::<i64>().is_ok_and(|n| n > 0),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct From {
    #[serde(default, deserialize_with = "opt_id")]
    pub id: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub is_bot: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ReplyTo {
    #[serde(default)]
    pub message_id: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Message {
    #[serde(default)]
    pub message_id: i64,
    #[serde(default)]
    pub chat: Chat,
    #[serde(default)]
    pub from: Option<From>,
    /// when it was sent, seconds
    #[serde(default)]
    pub date: Option<i64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub reply_to_message: Option<ReplyTo>,
    /// everything else: the forward fields, quotes, media
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Message {
    pub fn reply_to(&self) -> Option<i64> {
        self.reply_to_message
            .as_ref()
            .map(|r| r.message_id)
            .filter(|id| *id != 0)
    }
    /// Who is counted by the rate limit: the person, when the allowed id is a whole chat.
    pub fn rate_key(&self) -> String {
        self.from
            .as_ref()
            .and_then(|f| f.id.clone())
            .unwrap_or_else(|| self.chat.id.clone())
    }
    pub fn sender_name(&self) -> String {
        self.from
            .as_ref()
            .and_then(|f| f.first_name.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TappedMessage {
    #[serde(default)]
    pub message_id: i64,
    #[serde(default)]
    pub chat: Option<Chat>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub message: Option<TappedMessage>,
}

impl CallbackQuery {
    pub fn chat_id(&self) -> Option<&str> {
        self.message
            .as_ref()
            .and_then(|m| m.chat.as_ref())
            .map(|c| c.id.as_str())
    }
    pub fn message_id(&self) -> Option<i64> {
        self.message
            .as_ref()
            .map(|m| m.message_id)
            .filter(|id| *id != 0)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Update {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<Message>,
    #[serde(default)]
    pub callback_query: Option<CallbackQuery>,
}

impl Update {
    /// An update from raw JSON: `None` when it has no integer `update_id` (a 400 at the webhook).
    pub fn parse(raw: &[u8]) -> Option<Self> {
        let v: Value = serde_json::from_slice(raw).ok()?;
        v.get("update_id")?.as_i64()?;
        serde_json::from_value(v).ok()
    }

    /// The chat it came from: a tap's message's, else the message's.
    pub fn chat_id(&self) -> Option<&str> {
        match (&self.callback_query, &self.message) {
            (Some(q), _) => q.chat_id(),
            (None, Some(m)) => Some(m.chat.id.as_str()),
            (None, None) => None,
        }
    }
}

const FORWARD_FIELDS: &[&str] = &[
    "forward_origin",
    "forward_from",
    "forward_from_chat",
    "forward_sender_name",
    "forward_date",
    "is_automatic_forward",
];

/// A forward's text is someone else's, but it arrives as the linked person's message, so it must
/// not run as theirs. The old fields count too: Bot API 7.0 replaced them, and old payloads have them.
pub fn forwarded(m: &Message) -> bool {
    FORWARD_FIELDS.iter().any(|f| {
        m.rest
            .get(*f)
            .is_some_and(|v| !v.is_null() && *v != Value::Bool(false))
    })
}

/// The name Settings shows for a linked chat.
pub fn chat_name(c: &Chat) -> String {
    if let Some(t) = c.title.as_deref().filter(|t| !t.is_empty()) {
        return t.to_owned();
    }
    let full = [c.first_name.as_deref(), c.last_name.as_deref()]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if full.is_empty() {
        c.username.clone().unwrap_or_default()
    } else {
        full
    }
}

/// `/name@bot rest`, as v1 read it: the command (lower-cased) and the rest, trimmed. `None`: not one.
pub fn slash_command(text: &str) -> Option<(String, &str)> {
    let word = |s: &str| {
        s.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(s.len())
    };
    let body = text.strip_prefix('/')?;
    let end = word(body);
    if end == 0 {
        return None;
    }
    let (name, mut rest) = body.split_at(end);
    if let Some(after) = rest.strip_prefix('@') {
        let bot = word(after);
        if bot > 0 {
            rest = &after[bot..];
        }
    }
    Some((name.to_ascii_lowercase(), rest.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(v: Value) -> Message {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn parses_numbers_and_strings_alike() {
        let u = Update::parse(br#"{"update_id":5,"message":{"message_id":9,"chat":{"id":-100,"type":"group"},"from":{"id":7,"first_name":"Ada"},"text":"hi","date":3}}"#).unwrap();
        let m = u.message.clone().unwrap();
        assert_eq!(m.chat.id, "-100");
        assert_eq!(m.rate_key(), "7");
        assert_eq!(m.sender_name(), "Ada");
        assert!(!m.chat.solo());
        assert_eq!(u.chat_id(), Some("-100"));
    }

    #[test]
    fn not_an_update() {
        assert!(Update::parse(b"nope").is_none());
        assert!(Update::parse(br#"{"update_id":"5"}"#).is_none());
        assert!(Update::parse(br#"{"message":{}}"#).is_none());
        assert!(Update::parse(br#"{"update_id":1.5}"#).is_none());
    }

    #[test]
    fn solo_by_type_then_sign() {
        assert!(msg(json!({"chat":{"id":5,"type":"private"}})).chat.solo());
        assert!(
            !msg(json!({"chat":{"id":5,"type":"supergroup"}}))
                .chat
                .solo()
        );
        assert!(msg(json!({"chat":{"id":5}})).chat.solo());
        assert!(!msg(json!({"chat":{"id":-5}})).chat.solo());
    }

    #[test]
    fn every_forward_field_counts() {
        for f in FORWARD_FIELDS {
            assert!(forwarded(&msg(json!({ "text": "x", *f: 1 }))), "{f}");
        }
        assert!(!forwarded(&msg(
            json!({"text":"x","is_automatic_forward":false})
        )));
        assert!(!forwarded(&msg(json!({"text":"x","forward_date":null}))));
        assert!(!forwarded(&msg(
            json!({"text":"x","quote":{"text":"theirs"}})
        )));
    }

    #[test]
    fn names() {
        assert_eq!(
            chat_name(&msg(json!({"chat":{"id":1,"title":"Team"}})).chat),
            "Team"
        );
        assert_eq!(
            chat_name(&msg(json!({"chat":{"id":1,"first_name":"Ada","last_name":"L"}})).chat),
            "Ada L"
        );
        assert_eq!(
            chat_name(&msg(json!({"chat":{"id":1,"username":"ada"}})).chat),
            "ada"
        );
    }

    #[test]
    fn commands() {
        assert_eq!(slash_command("/new fix it"), Some(("new".into(), "fix it")));
        assert_eq!(
            slash_command("/New@wispbot  @api fix"),
            Some(("new".into(), "@api fix"))
        );
        assert_eq!(slash_command("/help"), Some(("help".into(), "")));
        assert_eq!(slash_command("/newfoo"), Some(("newfoo".into(), "")));
        assert_eq!(slash_command("/ new"), None);
        assert_eq!(slash_command("new"), None);
        assert_eq!(
            slash_command("/new\nline two"),
            Some(("new".into(), "line two"))
        );
    }
}
