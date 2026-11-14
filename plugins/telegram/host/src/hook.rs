//! Telegram on a cloud wisp (v1 telegram.js "webhook"): a box sleeps, so it can't long-poll. It points the bot's
//! webhook at its URL on the grid, whose inbox holds each update, wakes the box and delivers it (`inbound`).
//! The grid may own the webhook itself (`held`): then a call here would take it back, so the box only reads what
//! it's handed. A secret only Telegram knows checks each delivery; the update ids seen are kept with the hook,
//! so a retry runs once. With no grid any more, a webhook left over is removed and the long poll takes over.

use serde_json::{Value, json};
use wisp_channels_api::hub::BoxGrid;
use wisp_channels_api::transport::{Headers, InboundOpts, InboundResult, header};
use wisp_kernel::{CancellationToken, Result};
use wisp_telegram_core::{self as core, Update};

use crate::{Telegram, id_text, s};

/// A box's memory ends when it sleeps, so the update ids seen go with the hook.
const SEEN_UPDATES: usize = 100;
const HOOK_RETRY_MS: u64 = 30_000;

/// What `hooked` decided: the webhook takes care of inbound (no polling), or poll.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Inbound {
    Hooked,
    Poll,
}

impl Telegram {
    fn hook(&self) -> Option<Value> {
        self.cfg().get("hook").filter(|h| h.is_object()).cloned()
    }
    fn mark_hook(&self, error: Option<String>, on: bool) {
        let mut st = wisp_channels_api::Status { ok: Some(error.is_none()), error, at: Some(self.hub.now_ms()), ..Default::default() };
        st.more.insert("webhook".into(), json!(on));
        self.hub.mark("telegram", st);
    }

    /// v1 `#hooked`: on a box, the grid's URL for this bot becomes its webhook, or the grid already holds it.
    pub(crate) async fn hooked(&self, stop: &CancellationToken) -> Inbound {
        let boxed = self.hub.grid().grid();
        if boxed.is_none() && self.hook().is_none() {
            return Inbound::Poll;
        }
        while !stop.is_cancelled() {
            match self.try_hook(boxed.as_ref()).await {
                Ok(i) => return i,
                Err(e) => {
                    self.mark_hook(Some(format!("Couldn’t set the webhook: {}", e.message)), false);
                    let wait = self.hub.tune("tgHookRetryMs").unwrap_or(HOOK_RETRY_MS);
                    tokio::select! {
                        () = stop.cancelled() => return Inbound::Hooked,
                        () = self.hub.sleep(wait) => {}
                    }
                }
            }
        }
        Inbound::Hooked
    }

    async fn try_hook(&self, boxed: Option<&BoxGrid>) -> Result<Inbound> {
        let token = s(&self.cfg(), "token").to_owned();
        let found = match boxed {
            Some(b) => {
                let grid = self.hub.grid();
                match grid.channel_url(b, "telegram", Some(&grid.bot_mark(&token)), false).await {
                    Ok(f) => f,
                    // no webhook to get in the way: poll while the grid can't be reached
                    Err(_) if self.hook().is_none() => return Ok(Inbound::Poll),
                    Err(e) => return Err(e),
                }
            }
            None => None,
        };
        let Some(found) = found else {
            // no hub here (a grid that turned it off, a config moved to a computer): what's left of it goes first
            if self.hook().is_none() {
                return Ok(Inbound::Poll);
            }
            self.api("deleteWebhook", json!({}), 15_000).await?;
            self.hub.set_cfg("telegram", json!({ "hook": null }));
            self.mark_hook(None, false);
            return Ok(Inbound::Poll);
        };
        if let Some(n) = found.dropped.filter(|n| *n > 0) {
            wisp_channels_api::Transport::dropped(self, n).await;
        }
        let seen = self.hook().and_then(|h| h.get("seen").cloned()).unwrap_or_else(|| json!([]));
        if found.held {
            // the grid owns the webhook: one call here would take it back
            self.hub.set_cfg("telegram", json!({ "hook": { "held": true, "seen": seen } }));
        } else {
            let Some(url) = found.url.as_deref().filter(|u| !u.is_empty()) else {
                return Err(wisp_kernel::WireError::unavailable("the grid gave no URL"));
            };
            self.set_hook(url, seen).await?;
        }
        self.mark_hook(None, true);
        Ok(Inbound::Hooked)
    }

    /// Only when Telegram doesn't already have it. A new URL keeps the secret and the seen list: updates held
    /// at the grid carry the secret they came with, so a new one would have the box refuse them all.
    async fn set_hook(&self, url: &str, seen: Value) -> Result<()> {
        let had = self.hook().unwrap_or_default();
        if s(&had, "url") == url && s(&self.api("getWebhookInfo", json!({}), 15_000).await?, "url") == url {
            return Ok(());
        }
        let secret = Some(s(&had, "secret")).filter(|x| !x.is_empty()).map_or_else(|| self.hub.random_hex(32), str::to_owned);
        self.api("setWebhook", json!({ "url": url, "secret_token": secret, "allowed_updates": core::UPDATES }), 15_000).await?;
        self.hub.set_cfg("telegram", json!({ "hook": { "url": url, "secret": secret, "seen": seen } }));
        Ok(())
    }

    /// From the linked chat, or, before there is one, the code that links it.
    fn ours(&self, u: &Update) -> bool {
        let cfg = self.cfg();
        let chat = id_text(&cfg["chatId"]);
        if chat.is_empty() {
            let code = s(&cfg, "linkCode");
            return u
                .message
                .as_ref()
                .and_then(|m| m.text.as_deref())
                .and_then(core::links_it)
                .is_some_and(|c| core::secret_ok(Some(c), code));
        }
        u.chat_id() == Some(chat.as_str())
    }

    /// v1 `inbound`: an update the grid held. Only Telegram knows the secret, and only a retry repeats an update.
    /// `verified`: the grid owns the webhook and checked its own secret; only its delivery can say so.
    pub(crate) fn held(&self, raw: &[u8], headers: &Headers, opts: InboundOpts) -> (InboundResult, Option<Update>) {
        // one at a time: two deliveries reading the same `seen` would each drop the other's id
        let _one = self.hook_turn.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let ready = wisp_channels_api::Transport::ready(self);
        if opts.verified && ready && self.hook().is_none() {
            self.hub.set_cfg("telegram", json!({ "hook": { "held": true, "seen": [] } }));
        }
        let Some(hook) = self.hook().filter(|_| ready) else { return (InboundResult::error(409, "Telegram isn’t on here."), None) };
        if !opts.verified && !core::secret_ok(header(headers, "x-telegram-bot-api-secret-token"), s(&hook, "secret")) {
            return (InboundResult::error(403, "Wrong secret token."), None);
        }
        let Some(u) = Update::parse(raw) else { return (InboundResult::error(400, "Not an update."), None) };
        // a stranger's update really came from Telegram: this 403 tells the grid nobody wanted it, and stops
        // paying for a stranger's wakes
        let stranger = (!self.ours(&u)).then(|| InboundResult::error(403, "Not from the linked chat."));
        let mut seen: Vec<i64> = hook["seen"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect();
        if seen.contains(&u.update_id) {
            return (stranger.unwrap_or_else(|| InboundResult::new(200, json!({ "ok": true, "duplicate": true }))), None);
        }
        seen.push(u.update_id);
        let skip = seen.len().saturating_sub(SEEN_UPDATES);
        let mut hook = hook;
        hook["seen"] = json!(seen.into_iter().skip(skip).collect::<Vec<_>>());
        self.hub.set_cfg("telegram", json!({ "hook": hook }));
        match stranger {
            Some(r) => (r, None),
            None => (InboundResult::ok(), Some(u)),
        }
    }
}
