//! A Slack message through wisp.channels' flow (v1 slack.js `#message`): the grammar, capped at Edits (Plan when it
//! names none), answered in the message's thread. In a channel others read what's said, so the status line keeps
//! only a title's first part.

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::conversation::{Conversation, first_part};
use wisp_channels_api::{ChannelCtx, Mode, Parsed, Phone, Thread};
use wisp_kernel::Result;
use wisp_slack_core::event::Message;

use crate::{NAME, Slack};

pub(crate) struct SlackConv<'a> {
    pub slack: &'a Slack,
    pub phone: std::sync::Arc<dyn Phone>,
    pub ctx: ChannelCtx,
    pub m: &'a Message,
    /// the thread it answers in
    pub root: String,
}

#[async_trait]
impl Conversation for SlackConv<'_> {
    fn phone(&self) -> &dyn Phone {
        self.phone.as_ref()
    }
    fn ctx(&self) -> &ChannelCtx {
        &self.ctx
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn channel(&self) -> &str {
        NAME
    }
    fn name(&self) -> &str {
        &self.m.user
    }
    fn sender(&self) -> &str {
        &self.m.user
    }
    /// anyone in a channel can read it, and a DM is still a chat: never Full auto
    fn cap(&self) -> Mode {
        Mode::Edits
    }
    fn fallback(&self) -> Option<Mode> {
        Some(Mode::Plan)
    }
    fn approvals(&self) -> bool {
        false
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn no_thread(&self) -> &str {
        "Do that in a task’s thread."
    }
    async fn say(&self, text: String) -> Result<Value> {
        self.slack.post(&self.m.channel, &self.root, &text).await
    }
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        let mut more = std::collections::BTreeMap::new();
        more.insert("chat".into(), json!(self.m.channel));
        more.insert("ts".into(), json!(self.root));
        Some(Thread { channel: NAME.into(), reference: Some(format!("{}:{}", self.m.channel, self.root)), session: None, more })
    }
    /// the first reply went: the task keeps its thread, so its report and a mention there reach it
    fn acked(&self, thread: Option<&Thread>, _sent: &Value) {
        if let Some(s) = thread.and_then(|t| t.session.as_deref()) {
            let hub = &self.slack.hub;
            let mut r = hub.remote_of(s).unwrap_or_default();
            r.insert(NAME.into(), json!({ "channel": self.m.channel, "ts": self.root }));
            hub.set_remote(s, r);
            hub.mark_started(s, NAME, None);
        }
    }
    fn quiet(&self, line: String) -> String {
        if self.m.dm { line } else { first_part(&line) }
    }
}
