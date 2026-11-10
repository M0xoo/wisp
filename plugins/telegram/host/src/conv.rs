//! Telegram with `options` on (v1 telegram.js `#withOptions`): a message reads as the launcher's grammar (`in api
//! with opus plan: fix it`), through wisp.channels' flow (`ChannelHub::converse`). Only a private chat is one
//! person: in a group anyone there can steer wisp, so no Full auto. A reply to a task's message is that task's
//! thread. The flow raises `chat.message` for triggers (ADR-0043).

use async_trait::async_trait;
use serde_json::Value;
use wisp_channels_api::conversation::Conversation;
use wisp_channels_api::markup::{Markup, strip_formatting};
use wisp_channels_api::{ChannelCtx, Mode, Parsed, Phone, Thread};
use wisp_kernel::Result;
use wisp_telegram_core::Message;

use crate::Telegram;

pub(crate) struct TgConv<'a> {
    pub tg: &'a Telegram,
    pub phone: std::sync::Arc<dyn Phone>,
    pub ctx: ChannelCtx,
    pub m: &'a Message,
    /// the person, as Telegram names them
    pub name: String,
    /// the message replied to isn't linked to a task any more
    pub stale: bool,
}

/// The most a chat may ask for: a private chat is one person; a group is anyone in it.
pub(crate) fn cap_of(m: &Message) -> Mode {
    let solo = m.chat.kind.as_deref().map_or_else(|| m.chat.id.parse::<i64>().is_ok_and(|n| n > 0), |k| k == "private");
    if solo { Mode::Auto } else { Mode::Edits }
}

/// The message as the grammar reads it: `@bot` and `/new@bot` gone.
pub(crate) fn text_of(m: &Message, bot: &str) -> String {
    strip_formatting(m.text.as_deref().unwrap_or_default(), Markup::Telegram, bot)
}

#[async_trait]
impl Conversation for TgConv<'_> {
    fn phone(&self) -> &dyn Phone {
        self.phone.as_ref()
    }
    fn ctx(&self) -> &ChannelCtx {
        &self.ctx
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature: other channels name theirs at run time
    fn channel(&self) -> &str {
        "telegram"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn sender(&self) -> &str {
        &self.m.chat.id
    }
    fn cap(&self) -> Mode {
        cap_of(self.m)
    }
    fn approvals(&self) -> bool {
        false
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn no_thread(&self) -> &str {
        "Reply to the task’s message to do that."
    }
    async fn say(&self, text: String) -> Result<Value> {
        self.tg.say(&text, Some(self.m.message_id)).await
    }
    /// a list holds only what you named yourself, its @names there to be copied: sent as it is; status holds
    /// titles agents wrote, so it goes through `say`
    async fn list(&self, p: &Parsed, text: String) -> Result<Value> {
        if p.command.as_deref() == Some("status") {
            return self.say(text).await;
        }
        self.tg.say_raw(&text).await
    }
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        let mut more = std::collections::BTreeMap::new();
        more.insert("chat".into(), Value::String(self.m.chat.id.clone()));
        more.insert("message".into(), Value::from(self.m.message_id));
        Some(Thread { channel: "telegram".into(), reference: None, session: None, more })
    }
    fn stale(&self, p: &Parsed) -> Option<String> {
        (self.stale && p.command.as_deref() != Some("new")).then(|| "That message isn’t linked to a task any more. Send it without replying to start a new one.".to_owned())
    }
    /// the first reply went out: a reply to it reaches the task
    fn acked(&self, thread: Option<&Thread>, sent: &Value) {
        if let (Some(s), Some(mid)) = (thread.and_then(|t| t.session.as_deref()), sent.get("message_id").and_then(Value::as_i64)) {
            self.tg.link(s, mid);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn msg(chat: &serde_json::Value, text: &str) -> Message {
        serde_json::from_value(serde_json::json!({ "message_id": 7, "chat": chat, "text": text })).unwrap()
    }

    #[test]
    fn only_a_private_chat_may_ask_for_full_auto() {
        assert_eq!(cap_of(&msg(&serde_json::json!({ "id": 42, "type": "private" }), "x")), Mode::Auto);
        assert_eq!(cap_of(&msg(&serde_json::json!({ "id": -100, "type": "group" }), "x")), Mode::Edits);
        assert_eq!(cap_of(&msg(&serde_json::json!({ "id": -100 }), "x")), Mode::Edits, "no type: a negative id is a group");
        assert_eq!(text_of(&msg(&serde_json::json!({ "id": 1 }), "/new@wispbot in api fix it"), "wispbot"), "/new in api fix it");
    }
}
