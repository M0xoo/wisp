//! A gateway message read down to what a person sent (v1 discord.js `#fromMessage`): no bots, no webhooks, no joins
//! or pins; in a server only a mention of this bot carries its text (no privileged intent).

use serde_json::Value;

/// A reply (message type 19).
const REPLY: u64 = 19;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub channel: String,
    /// a direct message (no guild)
    pub dm: bool,
    pub author: String,
    pub content: String,
    /// the message it replies to
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Bot,
    Kind,
    NotForMe,
}

pub fn message(d: &Value, me: &str) -> Result<Message, Skip> {
    let author = d["author"]["id"].as_str().unwrap_or_default();
    if d["author"]["bot"] == true || d.get("webhook_id").is_some_and(|w| !w.is_null()) || author.is_empty() || author == me {
        return Err(Skip::Bot);
    }
    let kind = d["type"].as_u64().unwrap_or(0);
    if kind != 0 && kind != REPLY {
        return Err(Skip::Kind);
    }
    let dm = d.get("guild_id").is_none_or(Value::is_null);
    let mentioned = d["mentions"].as_array().is_some_and(|m| m.iter().any(|u| u["id"] == me));
    if !dm && !mentioned {
        return Err(Skip::NotForMe);
    }
    Ok(Message {
        id: d["id"].as_str().unwrap_or_default().to_owned(),
        channel: d["channel_id"].as_str().unwrap_or_default().to_owned(),
        dm,
        author: author.to_owned(),
        content: d["content"].as_str().unwrap_or_default().to_owned(),
        reference: d["message_reference"]["message_id"].as_str().map(str::to_owned),
    })
}

/// When a snowflake id was made, ms since the epoch.
pub fn snowflake_ms(id: &str) -> Option<i64> {
    let n: u64 = id.parse().ok()?;
    i64::try_from((n >> 22) + 1_420_070_400_000).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_persons_dm_or_mention_of_this_bot_is_read() {
        let m = |d: Value| message(&d, "B");
        let dm = m(json!({ "id": "1", "channel_id": "D1", "author": { "id": "U1" }, "type": 0, "content": "fix it" })).unwrap();
        assert!(dm.dm && dm.author == "U1" && dm.content == "fix it");
        assert_eq!(m(json!({ "author": { "id": "U1" }, "guild_id": "G", "type": 0, "mentions": [] })), Err(Skip::NotForMe), "a guild message without a mention");
        let reply = m(json!({ "id": "2", "channel_id": "C", "author": { "id": "U1" }, "guild_id": "G", "type": 19, "mentions": [{ "id": "B" }], "content": "<@B> more", "message_reference": { "message_id": "9" } })).unwrap();
        assert_eq!((reply.dm, reply.reference.as_deref()), (false, Some("9")));
        assert_eq!(m(json!({ "author": { "id": "U2", "bot": true } })), Err(Skip::Bot));
        assert_eq!(m(json!({ "author": { "id": "B" } })), Err(Skip::Bot), "its own");
        assert_eq!(m(json!({ "author": { "id": "U1" }, "type": 7 })), Err(Skip::Kind), "a join");
        assert_eq!(snowflake_ms("175928847299117063"), Some(1_462_015_105_796));
    }
}
