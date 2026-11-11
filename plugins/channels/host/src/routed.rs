//! A message the grid routed here (`on laptop …` to your routing bot; grid route.rs): through wisp.channels' own
//! flow, if this computer accepts tasks from channels (`channels.acceptChannels`, off by default: it's switched on
//! at the computer itself). Its first reply goes back in the answer, which the grid says in the chat; the thread is
//! kept on the task (`remote.routed`), so a follow-up in that chat reaches the same task.
//!
//! Not here yet: a task's later report going back to the chat (`grid-client` posting `/api/channels/reply`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::conversation::Conversation;
use wisp_channels_api::{ChannelCtx, ChannelHub, HttpOut, Mode, Parsed, Phone, Thread};
use wisp_kernel::{Ctx, Result};

pub const ACCEPT: &str = "channels.acceptChannels";
pub const OFF: &str = "This computer doesn’t take tasks from channels: turn on Settings → Phone → Accept tasks from channels on it.";

/// One routed message's door: what it said is kept for the grid's answer.
struct Door {
    phone: Arc<dyn Phone>,
    ctx: ChannelCtx,
    name: String,
    sender: String,
    thread: String,
    said: Mutex<Vec<String>>,
    hub: Arc<dyn ChannelHub>,
}

#[async_trait]
impl Conversation for Door {
    fn phone(&self) -> &dyn Phone {
        self.phone.as_ref()
    }
    fn ctx(&self) -> &ChannelCtx {
        &self.ctx
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn channel(&self) -> &str {
        "routed"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn sender(&self) -> &str {
        &self.sender
    }
    /// through the grid: never Full auto
    fn cap(&self) -> Mode {
        Mode::Edits
    }
    fn approvals(&self) -> bool {
        false
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn no_thread(&self) -> &str {
        "Reply to the task’s message in that chat to do that."
    }
    async fn say(&self, text: String) -> Result<Value> {
        self.said.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(text);
        Ok(json!({}))
    }
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        Some(Thread { channel: "routed".into(), reference: Some(self.thread.clone()), session: None, more: std::collections::BTreeMap::new() })
    }
    /// the first reply went: the task keeps its thread, for the chat's follow-ups
    fn acked(&self, thread: Option<&Thread>, _sent: &Value) {
        if let Some(s) = thread.and_then(|t| t.session.as_deref()) {
            let mut r = self.hub.remote_of(s).unwrap_or_default();
            r.insert("routed".into(), json!(self.thread));
            self.hub.set_remote(s, r);
        }
    }
}

/// Why a routed message is refused before anything reads it: this computer doesn't accept them, or it has no
/// thread or no words.
pub fn refused(accept: Option<&Value>, a: &Value) -> Option<HttpOut> {
    if accept != Some(&Value::Bool(true)) {
        return Some(HttpOut { status: 403, body: json!({ "reply": OFF }) });
    }
    let empty = |k: &str| a.get(k).and_then(Value::as_str).is_none_or(|v| v.trim().is_empty());
    (empty("thread") || empty("text")).then(|| HttpOut { status: 400, body: json!({ "reply": "Nothing to do there." }) })
}

/// `channels.routed`: `{channel, name, text, sender, id, at, thread, follow}` from the grid, through the tunnel.
pub async fn handle(ctx: &Ctx, hub: Arc<dyn ChannelHub>, a: &Value) -> Result<HttpOut> {
    if let Some(no) = refused(ctx.setting(ACCEPT).as_ref(), a) {
        return Ok(no);
    }
    let s = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let thread = s("thread");
    let phone = hub.phone();
    let door = Door { ctx: phone.context().await?, phone, name: s("name"), sender: s("sender"), thread: thread.clone(), said: Mutex::default(), hub: hub.clone() };
    // a follow-up in that chat: the task its thread belongs to
    let session = (a.get("follow") == Some(&Value::Bool(true))).then(|| hub.find_remote(&|r, _| r.get("routed").and_then(Value::as_str) == Some(thread.as_str())).into_iter().next()).flatten();
    if a.get("follow") == Some(&Value::Bool(true)) && session.is_none() {
        return Ok(HttpOut { status: 404, body: json!({ "reply": "That task isn’t here any more, so this wasn’t sent." }) });
    }
    hub.converse(&door, &s("text"), session.as_deref(), None).await?;
    let said = door.said.lock().unwrap_or_else(std::sync::PoisonError::into_inner).join("\n\n");
    Ok(HttpOut { status: 200, body: json!({ "reply": said }) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_routed_message_is_refused_unless_this_computer_accepts_channels() {
        let msg = json!({ "thread": "t.sig", "text": "fix the login" });
        assert_eq!(refused(None, &msg).map(|o| o.status), Some(403), "off by default");
        assert_eq!(refused(Some(&json!(false)), &msg).unwrap().body["reply"], OFF);
        assert!(refused(Some(&json!(true)), &msg).is_none());
        assert_eq!(refused(Some(&json!(true)), &json!({ "thread": "t", "text": " " })).map(|o| o.status), Some(400));
    }
}
