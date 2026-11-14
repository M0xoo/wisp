//! `on laptop` in a message to your wisp (v1 grid/route.js): the grid owns a Telegram bot's webhook, reads the
//! place, and the computer does the work; the box is never asked. A prompt injection in a box must never reach a
//! laptop, so nothing here takes a box's word for anything.
//!
//! - **The bot is yours, not the box's:** the account page gives the grid the bot's token (the grid's own origin,
//!   never the Box secret), and the grid calls `setWebhook` with a URL and a secret of its own, both sealed.
//! - **Who may route:** only a listed person, in a private chat with the bot (in a group others could read what
//!   comes back and steer it), never a forward.
//! - **`on <computer>` comes first** (the shared grammar, `wisp_channels_core::grammar::parse_route`); then
//!   `POST /api/channels/routed` through that computer's tunnel, marked `x-wisp-route: grid` (which the edge drops
//!   from everything else). The computer answers only if it switched on accepting tasks from channels.
//! - **The way back:** each routed message gets a thread, all `POST /api/channels/reply` takes with a device token,
//!   and it reaches that one chat. A reply in the chat to something the grid sent there is a follow-up, to the same
//!   computer. Threads last a week for reports, a month to say they've expired.
//! - Anything else on the bot: a line saying what it does, to the listed people only.
//!
//! Not here yet: the account page's form (the JSON API is `PUT/GET/DELETE /api/channels/route`), and a box that
//! holds the same bot (v1's `botMark`): such messages get the explaining line instead of going to the box.

use std::sync::Arc;

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::{ComputerRow, UserRow};
use crate::secrets::{Secrets, safe_equal, sha256, token};

pub const ROUTE_MARK: &str = "x-wisp-route";
const MAX_SENDERS: usize = 20;
const TEXT_MAX: usize = 4000;
const THREAD_TTL_MS: i64 = 7 * 86_400_000;
const THREAD_KEEP_MS: i64 = 30 * 86_400_000;
const THREAD_MSGS: i64 = 40;
const SEALED: &str = "route:telegram";
pub const EXPIRED: &str = "That thread has expired, so this wasn’t sent. Start again with “on” and the computer’s name.";

/// What's sealed for a user's route.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Bot {
    pub bot: String,
    pub name: String,
    pub secret: String,
    pub senders: Vec<String>,
}

/// `BotFather`'s `123456:ABC-DEF`.
pub fn bot_token_ok(t: &str) -> bool {
    t.split_once(':').is_some_and(|(id, rest)| {
        (1..=20).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_digit())
            && (1..=100).contains(&rest.len())
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// The people who may route, as typed (ids, comma or space apart).
pub fn senders_of(text: &str) -> std::result::Result<Vec<String>, String> {
    let mut ids: Vec<String> = Vec::new();
    for x in text.split([',', ' ', '\n', '\t']).filter(|x| !x.is_empty()) {
        if !(1..=20).contains(&x.len()) || !x.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Telegram user ids are numbers: @userinfobot tells you yours.".into());
        }
        if !ids.iter().any(|i| i == x) {
            ids.push(x.to_owned());
        }
    }
    if ids.is_empty() {
        return Err("Telegram user ids are numbers: @userinfobot tells you yours.".into());
    }
    if ids.len() > MAX_SENDERS {
        return Err(format!("At most {MAX_SENDERS} people."));
    }
    Ok(ids)
}

/// A listed person, in a private chat with the bot, not a forward.
pub fn person(m: &Value, b: &Bot) -> bool {
    let from = &m["from"];
    let id = from["id"].as_i64().map(|n| n.to_string()).unwrap_or_default();
    from.is_object()
        && from["is_bot"] != json!(true)
        && m["chat"]["type"] == "private"
        && b.senders.contains(&id)
        && m.get("forward_origin").is_none()
        && m.get("forward_date").is_none()
}

/// Telegram's Bot API, as the grid calls it.
#[async_trait::async_trait]
pub trait Telegram: Send + Sync {
    async fn call(&self, bot: &str, method: &str, body: Value) -> std::result::Result<Value, String>;
}

/// A computer, through its tunnel: `(status, body)`, or None when it isn't online.
#[async_trait::async_trait]
pub trait Computers: Send + Sync {
    async fn routed(&self, computer: &str, body: Value) -> std::result::Result<Option<(u16, Value)>, String>;
}

pub struct Routes {
    pub db: Arc<Db>,
    pub clock: SharedClock,
    pub secrets: Option<Arc<Secrets>>,
    pub telegram: Arc<dyn Telegram>,
    pub computers: Arc<dyn Computers>,
    pub public_url: String,
    pub on: bool,
}

impl std::fmt::Debug for Routes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Routes").field("on", &self.on).finish_non_exhaustive()
    }
}

/// What to do after Telegram has its 200: a line to say, or a message to send on.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    Say { chat: String, text: String, reply_to: i64 },
    Forward { thread: String, computer: String, body: Value, chat: String, reply_to: i64, fresh: bool },
}

#[derive(Debug, Clone)]
struct Thread {
    id: String,
    computer_id: String,
    chat: String,
    message: i64,
    created_at: i64,
}

impl Routes {
    fn secrets(&self) -> Result<&Secrets> {
        self.secrets.as_deref().ok_or_else(|| bad("This grid has no master key, so it routes nothing.", 503))
    }

    pub fn bot_of(&self, user_id: &str) -> Result<Option<Bot>> {
        Ok(self.secrets()?.open_secret(user_id, SEALED)?.and_then(|r| serde_json::from_str(&r).ok()))
    }

    /// The account page's: the bot's token and who may route. The webhook is the grid's own, with its own secret.
    pub async fn set(&self, user: &UserRow, bot: &str, senders: &str) -> Result<String> {
        if !self.on {
            return Err(bad("This grid doesn’t route messages to computers.", 404));
        }
        let bot = bot.trim();
        if !bot_token_ok(bot) {
            return Err(bad("That doesn’t look like a bot token: BotFather’s looks like 123456:ABC-DEF.", 400));
        }
        let senders = senders_of(senders).map_err(|e| bad(e, 400))?;
        let me = self.telegram.call(bot, "getMe", json!({})).await.map_err(|e| bad(format!("Telegram said: {e}"), 400))?;
        let had = self.bot_of(&user.id)?;
        let url = token("", 32);
        let secret = crate::secrets::hex(&crate::secrets::random_bytes(32));
        let b = Bot { bot: bot.into(), name: me["username"].as_str().unwrap_or_default().into(), secret: secret.clone(), senders };
        // sealed first: the box asking meanwhile hears that it's held
        self.keep(&user.id, &b, &sha256(&url))?;
        let hook = json!({ "url": format!("{}/_route/{url}", self.public_url), "secret_token": secret, "allowed_updates": ["message", "callback_query"] });
        if let Err(e) = self.telegram.call(bot, "setWebhook", hook).await {
            match &had {
                Some(h) => self.keep(&user.id, h, "")?,
                None => self.forget(&user.id)?,
            }
            return Err(bad(format!("Telegram said: {e}"), 400));
        }
        if let Some(h) = had.filter(|h| h.bot != b.bot) {
            let _ = self.telegram.call(&h.bot, "deleteWebhook", json!({})).await; // the old bot stops calling
        }
        Ok(b.name)
    }

    fn keep(&self, user_id: &str, b: &Bot, token_hash: &str) -> Result<()> {
        self.secrets()?.seal(user_id, SEALED, &serde_json::to_string(b).unwrap_or_default())?;
        if !token_hash.is_empty() {
            let now = self.clock.now_ms();
            self.db.with(|c| c.execute("INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?1, 'telegram', ?2, ?3) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at", params![user_id, token_hash, now]))?;
        }
        Ok(())
    }

    fn forget(&self, user_id: &str) -> Result<()> {
        self.secrets()?.drop_secret(user_id, SEALED)?;
        self.db.with(|c| c.execute("DELETE FROM channel_routes WHERE user_id = ?1", [user_id]))?;
        Ok(())
    }

    pub async fn remove(&self, user: &UserRow) -> Result<()> {
        if let Some(b) = self.bot_of(&user.id)? {
            let _ = self.telegram.call(&b.bot, "deleteWebhook", json!({})).await;
        }
        self.forget(&user.id)?;
        self.db.with(|c| c.execute("DELETE FROM channel_threads WHERE user_id = ?1", [&user.id]))?;
        Ok(())
    }

    /// For the account page: never the token or the secret.
    pub fn view(&self, user_id: &str) -> Result<Value> {
        Ok(match self.bot_of(user_id)? {
            Some(b) => json!({ "set": true, "bot": b.name, "senders": b.senders }),
            None => json!({ "set": false, "bot": "", "senders": [] }),
        })
    }

    /// Whose webhook this is: Some(Ok(..)) when the secret is right, Some(Err) for a bad one, None for no route.
    pub fn check(&self, url_token: &str, secret: &str) -> Result<Option<std::result::Result<(String, Bot), ()>>> {
        if !self.on {
            return Ok(None);
        }
        let uid: Option<String> = self.db.with(|c| {
            c.query_row("SELECT user_id FROM channel_routes WHERE token_hash = ?1", [sha256(url_token)], |r| r.get(0)).optional()
        })?;
        let Some(uid) = uid else { return Ok(None) };
        let Some(b) = self.bot_of(&uid)? else { return Ok(None) };
        Ok(Some(if !secret.is_empty() && safe_equal(secret, &b.secret) { Ok((uid, b)) } else { Err(()) }))
    }

    fn thread(&self, id: &str) -> Result<Option<Thread>> {
        self.db.with(|c| {
            c.query_row("SELECT id, computer_id, chat, message, created_at FROM channel_threads WHERE id = ?1", [id], |r| {
                Ok(Thread { id: r.get(0)?, computer_id: r.get(1)?, chat: r.get(2)?, message: r.get(3)?, created_at: r.get(4)? })
            })
            .optional()
        })
    }

    fn thread_ref(&self, id: &str) -> Result<String> {
        Ok(format!("{id}.{}", self.secrets()?.sign(&format!("thread|{id}"))))
    }

    fn fresh(&self, t: &Thread) -> bool {
        t.created_at >= self.clock.now_ms() - THREAD_TTL_MS
    }

    /// One update past `check`. Decided at once, from the database, before Telegram gets its 200. `computers`: the
    /// user's, to read the place from. `first`: a retry of one already taken stops here. → what to do after.
    #[allow(clippy::many_single_char_names)] // v1's names: u update, m message, b bot, t thread
    pub fn take(
        &self,
        user: &UserRow,
        b: &Bot,
        u: &Value,
        computers: &[ComputerRow],
        first: &dyn Fn(&str) -> bool,
    ) -> Result<Option<Next>> {
        if let Some(id) = u["update_id"].as_i64()
            && !first(&format!("route:telegram:{id}"))
        {
            return Ok(None);
        }
        let m = &u["message"];
        let chat = m["chat"]["id"].as_i64().map(|n| n.to_string()).unwrap_or_default();
        let at = m["message_id"].as_i64().unwrap_or(0);
        let say = |text: &str| Some(Next::Say { chat: chat.clone(), text: text.into(), reply_to: at });
        let Some(raw) = m["text"].as_str().filter(|_| person(m, b)) else {
            return Ok(None);
        };
        let text = wisp_channels_core::grammar::strip_formatting(raw, wisp_channels_core::grammar::Markup::Telegram, &b.name);
        let sender = m["from"]["first_name"].as_str().unwrap_or_default().to_owned();
        let body = |thread: &str, text: &str, follow: bool| json!({ "channel": "telegram", "name": "Telegram", "text": text, "sender": sender, "id": u["update_id"].to_string(), "at": m["date"], "thread": thread, "follow": follow });
        if let Some(up) = m["reply_to_message"]["message_id"].as_i64() {
            let tid: Option<String> = self.db.with(|c| {
                c.query_row(
                    "SELECT thread_id FROM channel_thread_msgs WHERE user_id = ?1 AND chat = ?2 AND message = ?3",
                    params![user.id, chat, up],
                    |r| r.get(0),
                )
                .optional()
            })?;
            let t = tid.map(|t| self.thread(&t)).transpose()?.flatten().filter(|t| self.fresh(t));
            let Some(t) = t.filter(|t| computers.iter().any(|c| c.id == t.computer_id)) else { return Ok(say(EXPIRED)) };
            let r = self.thread_ref(&t.id)?;
            return Ok(Some(Next::Forward {
                thread: t.id.clone(),
                computer: t.computer_id.clone(),
                body: body(&r, &text, true),
                chat,
                reply_to: at,
                fresh: false,
            }));
        }
        let views: Vec<wisp_channels_api::MachineView> = computers
            .iter()
            .map(|c| wisp_channels_api::MachineView { id: c.id.clone(), name: c.name.clone(), usable: true, ..Default::default() })
            .collect();
        match wisp_channels_core::grammar::parse_route(&text, &views) {
            Some(wisp_channels_core::grammar::Route::Ambiguous(p)) => {
                Ok(say(&format!("{} They share that name, so nothing was sent.", p.first().map_or("", |x| x.text.as_str()))))
            }
            Some(wisp_channels_core::grammar::Route::To { machine, text }) => {
                let id = token("", 12);
                let now = self.clock.now_ms();
                self.db.with(|c| c.execute("INSERT INTO channel_threads (id, user_id, computer_id, channel, chat, message, created_at) VALUES (?1, ?2, ?3, 'telegram', ?4, ?5, ?6)", params![id, user.id, machine, chat, at, now]))?;
                let r = self.thread_ref(&id)?;
                Ok(Some(Next::Forward { thread: id, computer: machine, body: body(&r, &text, false), chat, reply_to: at, fresh: true }))
            }
            None => {
                let name = computers.first().map_or("laptop", |c| c.name.as_str());
                Ok(say(&format!(
                    "This bot only reaches your computers: say “on {name} fix the login”. For your cloud wisp, use its own bot."
                )))
            }
        }
    }

    /// A line in the chat; one sent in a thread is kept, so a reply to it is a follow-up there.
    pub async fn say(&self, user_id: &str, b: &Bot, chat: &str, text: &str, reply_to: i64, thread: Option<&str>) -> Result<()> {
        let t: String = text.chars().take(TEXT_MAX).collect();
        let sent = self
            .telegram
            .call(
                &b.bot,
                "sendMessage",
                json!({ "chat_id": chat, "text": t, "reply_to_message_id": reply_to, "allow_sending_without_reply": true }),
            )
            .await
            .map_err(|e| bad(format!("Telegram said: {e}"), 502))?;
        if let (Some(tid), Some(mid)) = (thread, sent["message_id"].as_i64()) {
            let now = self.clock.now_ms();
            self.db.with(|c| {
                c.execute("INSERT OR IGNORE INTO channel_thread_msgs (user_id, chat, message, thread_id, at) VALUES (?1, ?2, ?3, ?4, ?5)", params![user_id, chat, mid, tid, now])?;
                c.execute("DELETE FROM channel_thread_msgs WHERE thread_id = ?1 AND message NOT IN (SELECT message FROM channel_thread_msgs WHERE thread_id = ?1 ORDER BY at DESC, message DESC LIMIT ?2)", params![tid, THREAD_MSGS])
            })?;
        }
        Ok(())
    }

    /// After the 200: one try through the tunnel. Whatever comes of it, the person hears, and nothing waits anywhere.
    pub async fn run(&self, user_id: &str, b: &Bot, next: Next, computer_name: &str) -> Result<()> {
        match next {
            Next::Say { chat, text, reply_to } => self.say(user_id, b, &chat, &text, reply_to, None).await,
            Next::Forward { thread, computer, body, chat, reply_to, fresh } => {
                let offline = format!("{computer_name} is offline, so nothing was sent to it. Send this again when it’s back.");
                let lost = match self.computers.routed(&computer, body).await {
                    Err(_) => {
                        return self
                            .say(
                                user_id,
                                b,
                                &chat,
                                &format!("{computer_name} didn’t answer, so this may or may not have started. Open wisp there to check."),
                                reply_to,
                                Some(&thread),
                            )
                            .await;
                    }
                    Ok(None) => offline,
                    Ok(Some((status, v))) => {
                        let reply = v["reply"].as_str().unwrap_or_default().to_owned();
                        if status == 404 && reply.is_empty() {
                            format!("{computer_name} needs a newer wisp to take this.")
                        } else if status >= 300 {
                            if reply.is_empty() { format!("{computer_name} couldn’t take this.") } else { reply }
                        } else {
                            return if reply.is_empty() {
                                Ok(())
                            } else {
                                self.say(user_id, b, &chat, &reply, reply_to, Some(&thread)).await
                            };
                        }
                    }
                };
                // nothing started there: a new thread goes, and the person hears why
                if fresh {
                    self.db.with(|c| c.execute("DELETE FROM channel_threads WHERE id = ?1", [&thread]))?;
                }
                self.say(user_id, b, &chat, &lost, reply_to, None).await
            }
        }
    }

    /// A computer's report: that thread's chat, and only from the computer it was sent to.
    pub async fn reply(&self, user: &UserRow, computer: &ComputerRow, thread_ref: &str, text: &str) -> Result<()> {
        let no = || bad("No such thread.", 404);
        let (id, sig) = thread_ref.split_once('.').ok_or_else(no)?;
        if sig.contains('.') || !self.secrets()?.verify(&format!("thread|{id}"), sig) {
            return Err(no());
        }
        let t = self.thread(id)?.filter(|t| self.fresh(t) && t.computer_id == computer.id && computer.user_id == user.id).ok_or_else(no)?;
        let b = self.bot_of(&user.id)?.ok_or_else(no)?;
        if text.trim().is_empty() {
            return Err(bad("text is needed.", 400));
        }
        self.say(&user.id, &b, &t.chat, text, t.message, Some(&t.id)).await
    }

    pub fn sweep(&self) -> Result<usize> {
        let before = self.clock.now_ms() - THREAD_KEEP_MS;
        self.db.with(|c| c.execute("DELETE FROM channel_threads WHERE created_at < ?1", [before]))
    }
}

/// Telegram over HTTPS (grid.json `channels.telegramApi` for tests).
#[derive(Debug, Default)]
pub struct HttpTelegram {
    pub base: String,
    pub client: reqwest::Client,
}

#[async_trait::async_trait]
impl Telegram for HttpTelegram {
    async fn call(&self, bot: &str, method: &str, body: Value) -> std::result::Result<Value, String> {
        let r = self
            .client
            .post(format!("{}/bot{bot}/{method}", self.base.trim_end_matches('/')))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = r.status().as_u16();
        let j: Value = r.json().await.unwrap_or(Value::Null);
        if j["ok"] != json!(true) {
            return Err(j["description"].as_str().map_or_else(|| status.to_string(), str::to_owned));
        }
        Ok(j["result"].clone())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
