//! A Discord message through wisp.channels' flow (v1 discord.js `#work`, `#threadFor`): the grammar, capped at
//! Edits (Plan when none is named). In a server a task answers in its own thread, made on the message that asked; in
//! a DM, or where a thread can't be made, as replies to its messages. In a server others read it, so the status line
//! keeps only a title's first part.

use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::conversation::{Conversation, first_part};
use wisp_channels_api::scrub::{scrub_out, truncate};
use wisp_channels_api::{ChannelCtx, Mode, Parsed, Phone, Thread};
use wisp_discord_core::message::Message;
use wisp_kernel::Result;

use crate::{Discord, NAME, lock};

pub(crate) struct DiscordConv<'a> {
    pub discord: &'a Discord,
    pub phone: std::sync::Arc<dyn Phone>,
    pub ctx: ChannelCtx,
    pub m: &'a Message,
    /// where it answers: (channel, the message it replies to)
    pub target: Mutex<(String, Option<String>)>,
    pub in_thread: Mutex<bool>,
    /// `/wisp`'s reply, edited once (`/webhooks/<app>/<token>/messages/@original`), then posts go to the place
    pub hook: Mutex<Option<String>>,
    /// the message a thread is made on: the asking one, or `/wisp`'s "On it." (None until said)
    pub anchor: Mutex<Option<String>>,
    /// `/wisp` used in a thread: the task answers there (a slash command has no message to make one on)
    pub slash_thread: bool,
}

impl<'a> DiscordConv<'a> {
    pub fn new(discord: &'a Discord, phone: std::sync::Arc<dyn Phone>, ctx: ChannelCtx, m: &'a Message, hook: Option<String>) -> Self {
        let anchor = hook.is_none().then(|| m.id.clone());
        let reply = hook.is_none().then(|| m.id.clone());
        Self {
            discord,
            phone,
            ctx,
            m,
            target: Mutex::new((m.channel.clone(), reply)),
            in_thread: Mutex::new(false),
            hook: Mutex::new(hook),
            anchor: Mutex::new(anchor),
            slash_thread: false,
        }
    }

    fn plain(&self) -> Thread {
        let (chat, _) = lock(&self.target).clone();
        let mut more = std::collections::BTreeMap::new();
        more.insert("chat".into(), json!(chat));
        Thread { channel: NAME.into(), reference: Some(chat), session: None, more }
    }
}

#[async_trait]
impl Conversation for DiscordConv<'_> {
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
        &self.m.author
    }
    fn sender(&self) -> &str {
        &self.m.author
    }
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
        "Do that in a task’s thread, or as a reply to its message."
    }
    async fn say(&self, text: String) -> Result<Value> {
        let hook = lock(&self.hook).take();
        if let Some(path) = hook {
            // an interaction's token past its 15 minutes: the place itself then
            if let Ok(v) = self.discord.rest("PATCH", &path, Some(&crate::post_body(&text, None))).await {
                return Ok(v);
            }
        }
        let (chat, reply) = lock(&self.target).clone();
        self.discord.say(&chat, reply.as_deref(), &text).await
    }
    /// Where the task answers: in a server its own thread on the asking message (a task already in this thread
    /// stays in it); in a DM, or where Discord makes none, replies.
    async fn thread(&self, p: &Parsed) -> Option<Thread> {
        let held = self.discord.session_for(&self.m.channel, self.m.reference.as_deref());
        let in_this_thread = held
            .as_ref()
            .and_then(|h| self.discord.hub.remote_of(h))
            .and_then(|r| r.get(NAME).cloned())
            .is_some_and(|t| t["thread"] == true && t["channel"] == self.m.channel.as_str());
        if self.slash_thread {
            *lock(&self.in_thread) = true;
        } else if !self.m.dm && !in_this_thread {
            if lock(&self.anchor).is_none() && lock(&self.hook).is_some() {
                let said = self.say("▶ On it.".into()).await.ok();
                *lock(&self.anchor) = said.as_ref().and_then(|v| v.get("id")).and_then(Value::as_str).map(str::to_owned);
            }
            let Some(anchor) = lock(&self.anchor).clone() else { return Some(self.plain()) };
            let first = p.prompt.lines().next().unwrap_or_default();
            let name = Some(truncate(&scrub_out(first, false).text, 90)).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "wisp".into());
            let made = self
                .discord
                .rest(
                    "POST",
                    &format!("/channels/{}/messages/{anchor}/threads", self.m.channel),
                    Some(&json!({ "name": name, "auto_archive_duration": 1440 })),
                )
                .await;
            if let Ok(t) = made
                && let Some(id) = t.get("id").and_then(Value::as_str)
            {
                *lock(&self.target) = (id.to_owned(), None);
                *lock(&self.in_thread) = true;
            }
        } else if in_this_thread {
            *lock(&self.in_thread) = true;
        }
        Some(self.plain())
    }
    /// The first reply went: the task keeps its thread (or the messages a reply may point at).
    fn acked(&self, thread: Option<&Thread>, sent: &Value) {
        let Some(s) = thread.and_then(|t| t.session.as_deref()) else { return };
        let hub = &self.discord.hub;
        let (chat, _) = lock(&self.target).clone();
        let mut r = hub.remote_of(s).unwrap_or_default();
        let anchor = lock(&self.anchor).clone();
        let ids: Vec<Value> = [anchor.as_deref(), sent.get("id").and_then(Value::as_str)].into_iter().flatten().map(|i| json!(i)).collect();
        r.insert(NAME.into(), json!({ "channel": chat, "thread": *lock(&self.in_thread), "ids": ids }));
        hub.set_remote(s, r);
        hub.mark_started(s, NAME, None);
    }
    fn quiet(&self, line: String) -> String {
        if self.m.dm { line } else { first_part(&line) }
    }
}
