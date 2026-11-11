//! Channels reaching a sleeping box (v1 grid/inbox.js). A channel posts to `<handle>.<domain>/_in/<token>`; the
//! grid keeps the request, answers 200 at once, wakes the box and delivers it to the box's `channels.inbound`, in
//! order and one at a time. The grid reads nothing a person said and checks no signature: the box verifies each
//! message itself. A row is held for an hour at most; once delivered it keeps only its event key, which stops a
//! sender's retry.
//!
//! - **Wakes are earned:** a channel never keeps a box awake. After `wake_strikes` wakes in a row with nothing the
//!   box accepted (a 2xx), the next is a scheduled wake (behind people, evicting nobody), at most one per `wake_gap_ms`.
//! - **Strictly in order:** nothing passes a row being retried; a 4xx is the box saying no (finished), anything
//!   else is retried with backoff, then dropped and counted after `MAX_TRIES`.
//! - **Caps:** `max_rows` and `max_bytes` held per user, `BODY_MAX` a body; over them, dropped and counted
//!   (`channel_urls.dropped`, which the box is told with its next delivery), still a 200 to the sender.
//! - **Live:** a request the sender wants answered in the same call (Slack's URL check) goes through only to a box
//!   already up, and never wakes one; asleep, 503.
//! - Nothing a message said goes to a log: channel and size only.
//!
//! Not here yet: Discord's edge (it answers an interaction's PING itself, with the box's public key), mail's
//! provider webhook (`mail.rs`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::boxhost::{BoxHost, BoxState, Busy, Running};
use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::{BoxUser, UserRow};
use crate::secrets::{Secrets, sha256, token};

pub const BODY_MAX: usize = 256 * 1024;
const TTL_MS: i64 = 60 * 60_000;
const MAX_TRIES: i64 = 5;

/// What a channel's request is worth keeping, and how to read it.
#[derive(Debug)]
pub struct ChannelDef {
    pub name: &'static str,
    /// the headers the box needs to check it (its signature)
    pub headers: &'static [&'static str],
    pub event_id: fn(&Value) -> Option<String>,
    /// the sender wants the box's answer in this same call
    pub live: fn(&Value) -> bool,
    /// what no box acts on: not held (a wake for it would be refused and count as a strike)
    pub skip: fn(&Value) -> bool,
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str().map(str::to_owned).or_else(|| x.as_i64().map(|n| n.to_string())))
}

/// Slack posts an edit, a deletion and wisp's own replies like any message; a file is the one subtype that is
/// someone speaking.
fn slack_noise(j: &Value) -> bool {
    let e = &j["event"];
    e.is_object() && (e.get("bot_id").is_some_and(|b| !b.is_null()) || e.get("subtype").and_then(Value::as_str).is_some_and(|s| s != "file_share"))
}

pub const CHANNELS: [ChannelDef; 4] = [
    ChannelDef { name: "telegram", headers: &["x-telegram-bot-api-secret-token"], event_id: |j| str_of(j.get("update_id")), live: |_| false, skip: |_| false },
    ChannelDef { name: "slack", headers: &["x-slack-signature", "x-slack-request-timestamp"], event_id: |j| str_of(j.get("event_id")), live: |j| j.get("type").and_then(Value::as_str) == Some("url_verification"), skip: slack_noise },
    ChannelDef { name: "discord", headers: &["x-signature-ed25519", "x-signature-timestamp"], event_id: |j| str_of(j.get("id")), live: |j| j.get("type").and_then(Value::as_i64) == Some(1), skip: |_| false },
    // held by the grid's mail (mail/service.rs), never by a request: its headers are the grid's own verdict
    ChannelDef { name: "email", headers: &["x-wisp-mail-from", "x-wisp-mail-dmarc", "x-wisp-mail-id"], event_id: |j| str_of(j.get("messageId")), live: |_| false, skip: |_| false },
];

/// A held message its box accepted (a 2xx): `(user id, the delivery)`. Mail keeps the thread then.
pub type Delivered = Arc<dyn Fn(&str, &Delivery) + Send + Sync>;

pub fn channel(name: &str) -> Option<&'static ChannelDef> {
    CHANNELS.iter().find(|c| c.name == name)
}

/// A request's row key: the channel's own event id, else the body's hash, and the headers it came with. An id alone
/// could be taken: anyone holding the URL could post the next update id with a bad secret, and the real update
/// would hit that row and vanish.
pub fn event_key(c: &ChannelDef, j: &Value, body: &[u8], headers: &str) -> String {
    let id = (c.event_id)(j).unwrap_or_else(|| sha256(body));
    format!("{}:{id}:{}", c.name, sha256(headers))
}

#[derive(Debug, Clone, Copy)]
pub struct Opts {
    pub enabled: bool,
    pub max_rows: i64,
    pub max_bytes: i64,
    pub ttl_ms: i64,
    pub retry_ms: i64,
    pub wake_retry_ms: i64,
    pub wake_strikes: u32,
    pub wake_gap_ms: i64,
    pub live_ms: u64,
}

impl Default for Opts {
    fn default() -> Self {
        Self { enabled: false, max_rows: 200, max_bytes: 2 * 1024 * 1024, ttl_ms: TTL_MS, retry_ms: 2000, wake_retry_ms: 30_000, wake_strikes: 3, wake_gap_ms: 10 * 60_000, live_ms: 2500 }
    }
}

/// One message on its way into a box.
#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub channel: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub at: i64,
    pub dropped: i64,
    pub verified: bool,
    pub key: String,
}

/// The box's side: what it answered (its transport's status and body).
#[async_trait::async_trait]
pub trait Deliver: Send + Sync {
    async fn deliver(&self, port: u16, secret: &str, d: &Delivery, timeout_ms: u64) -> std::result::Result<(u16, Value), String>;
}

/// The boxes as the inbox sees them (`hostd`), with the secret the box takes from the grid.
pub trait Boxes: Send + Sync {
    fn state(&self, user_id: &str) -> BoxState;
    fn port(&self, user_id: &str) -> Option<u16>;
    fn begin(&self, user_id: &str) -> Busy;
    fn ensure<'a>(&'a self, user: &'a BoxUser, wake: bool) -> futures::future::BoxFuture<'a, Result<Running>>;
    fn secret(&self, user_id: &str) -> Option<String>;
}

impl Boxes for crate::hostd::ProcessHost {
    fn state(&self, user_id: &str) -> BoxState {
        BoxHost::state(self, user_id)
    }
    fn port(&self, user_id: &str) -> Option<u16> {
        BoxHost::port(self, user_id)
    }
    fn begin(&self, user_id: &str) -> Busy {
        BoxHost::begin(self, user_id, false)
    }
    fn ensure<'a>(&'a self, user: &'a BoxUser, wake: bool) -> futures::future::BoxFuture<'a, Result<Running>> {
        BoxHost::ensure(self, user, wake)
    }
    fn secret(&self, user_id: &str) -> Option<String> {
        crate::hostd::ProcessHost::secret(self, user_id)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Strikes {
    n: u32,
    at: i64,
}

pub struct Inbox {
    pub db: Arc<Db>,
    pub clock: SharedClock,
    pub secrets: Option<Arc<Secrets>>,
    pub boxes: Arc<dyn Boxes>,
    pub deliver: Arc<dyn Deliver>,
    pub opts: Opts,
    /// a user's handle → its box's public URL
    pub url_of: Arc<dyn Fn(&str) -> String + Send + Sync>,
    wakes: Mutex<HashMap<String, Strikes>>,
    busy: tokio::sync::Mutex<()>,
    /// told of each delivery a box accepted (set once, by mail)
    pub delivered: std::sync::OnceLock<Delivered>,
}

impl std::fmt::Debug for Inbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inbox").field("opts", &self.opts).finish_non_exhaustive()
    }
}

/// What a sender gets beyond the 200: the box's own answer to a live request.
pub type Answer = Option<(u16, Value)>;

impl Inbox {
    pub fn new(db: Arc<Db>, clock: SharedClock, secrets: Option<Arc<Secrets>>, boxes: Arc<dyn Boxes>, deliver: Arc<dyn Deliver>, opts: Opts, url_of: Arc<dyn Fn(&str) -> String + Send + Sync>) -> Self {
        Self { db, clock, secrets, boxes, deliver, opts, url_of, wakes: Mutex::default(), busy: tokio::sync::Mutex::new(()), delivered: std::sync::OnceLock::new() }
    }

    fn secrets(&self) -> Result<&Secrets> {
        self.secrets.as_deref().ok_or_else(|| bad("This grid has no master key, so it holds no channels.", 503))
    }

    fn count(&self, user_id: &str, ch: &str) -> Result<()> {
        self.db.with(|c| c.execute("UPDATE channel_urls SET dropped = dropped + 1 WHERE user_id = ?1 AND channel = ?2", params![user_id, ch]))?;
        tracing::info!(channel = ch, "grid: inbox dropped a message");
        Ok(())
    }

    /// `{url, dropped}`: this user's own URL, made the first time; dropped: lost messages it hasn't been told of
    /// (this tells it). The token is kept sealed, so asking again gives the same URL.
    pub fn url_for(&self, user: &UserRow, ch: &str) -> Result<Value> {
        channel(ch).ok_or_else(|| bad("No such channel here.", 404))?;
        let sealed = self.secrets()?.ensure(&user.id, &format!("channel:{ch}"))?;
        let now = self.clock.now_ms();
        let dropped: i64 = self.db.with(|c| {
            c.execute("INSERT INTO channel_urls (user_id, channel, token_hash, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash", params![user.id, ch, sha256(&sealed), now])?;
            let d: i64 = c.query_row("SELECT dropped FROM channel_urls WHERE user_id = ?1 AND channel = ?2", params![user.id, ch], |r| r.get(0))?;
            if d > 0 {
                c.execute("UPDATE channel_urls SET dropped = 0 WHERE user_id = ?1 AND channel = ?2", params![user.id, ch])?;
            }
            Ok(d)
        })?;
        Ok(json!({ "url": format!("{}/_in/{sealed}", (self.url_of)(&user.handle)), "dropped": dropped }))
    }

    /// A new URL for a leaked one: the old token stops here; what's held stays.
    pub fn rotate(&self, user: &UserRow, ch: &str) -> Result<Value> {
        channel(ch).ok_or_else(|| bad("No such channel here.", 404))?;
        let fresh = token("", 32);
        self.secrets()?.seal(&user.id, &format!("channel:{ch}"), &fresh)?;
        self.db.with(|c| c.execute("UPDATE channel_urls SET token_hash = ?1 WHERE user_id = ?2 AND channel = ?3", params![sha256(&fresh), user.id, ch]))?;
        Ok(json!({ "url": format!("{}/_in/{fresh}", (self.url_of)(&user.handle)) }))
    }

    /// `(user id, channel)` for a URL's token.
    pub fn by_token(&self, t: &str) -> Result<Option<(String, String)>> {
        self.db.with(|c| c.query_row("SELECT user_id, channel FROM channel_urls WHERE token_hash = ?1 AND channel != 'email'", [sha256(t)], |r| Ok((r.get(0)?, r.get(1)?))).optional())
    }

    fn held(&self, user_id: &str) -> Result<(i64, i64)> {
        self.db.with(|c| c.query_row("SELECT count(*), coalesce(sum(size), 0) FROM channel_inbox WHERE user_id = ?1 AND done_at IS NULL", [user_id], |r| Ok((r.get(0)?, r.get(1)?))))
    }

    /// Keep what came. `body`: None when it was over `BODY_MAX`. → the sender's answer beyond the 200, if any.
    pub async fn accept(&self, user: &UserRow, ch: &str, headers: &[(String, String)], body: Option<&[u8]>) -> Result<Answer> {
        let def = channel(ch).ok_or_else(|| bad("No such channel here.", 404))?;
        let Some(body) = body else {
            self.count(&user.id, ch)?;
            return Ok(None);
        };
        let kept: Vec<(String, String)> = def.headers.iter().filter_map(|h| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(h)).map(|(_, v)| ((*h).to_owned(), v.clone()))).collect();
        let j: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        if (def.live)(&j) {
            return Ok(Some(self.live(user, ch, kept, body).await));
        }
        if (def.skip)(&j) {
            return Ok(None);
        }
        self.hold(user, def, body, &kept, false, &j)?;
        Ok(None)
    }

    /// A request that can't wait: the box's answer if it's up; asleep or starting, 503 (never woken).
    async fn live(&self, user: &UserRow, ch: &str, headers: Vec<(String, String)>, body: &[u8]) -> (u16, Value) {
        let asleep = (503, json!({ "error": "wisp is asleep: try again with it open." }));
        let (Some(port), Some(secret)) = (self.boxes.port(&user.id).filter(|_| self.boxes.state(&user.id) == BoxState::Running), self.boxes.secret(&user.id)) else { return asleep };
        let _busy = self.boxes.begin(&user.id);
        let d = Delivery { channel: ch.into(), headers, body: body.to_vec(), at: self.clock.now_ms(), dropped: 0, verified: false, key: format!("live:{}", sha256(body)) };
        match self.deliver.deliver(port, &secret, &d, self.opts.live_ms).await {
            Ok((s, v)) if s < 500 => (s, v),
            _ => asleep,
        }
    }

    /// Hold one message. `verified`: the grid checked it itself (a route); nothing from a request sets it. → false
    /// when it was dropped (over the caps).
    pub fn hold(&self, user: &UserRow, def: &ChannelDef, body: &[u8], headers: &[(String, String)], verified: bool, j: &Value) -> Result<bool> {
        let hj = serde_json::to_string(headers).unwrap_or_default();
        let size = i64::try_from(body.len() + hj.len()).unwrap_or(i64::MAX);
        let (n, bytes) = self.held(&user.id)?;
        if n >= self.opts.max_rows || bytes + size > self.opts.max_bytes {
            self.count(&user.id, def.name)?;
            return Ok(false);
        }
        let key = event_key(def, j, body, &hj);
        let now = self.clock.now_ms();
        self.db.with(|c| {
            c.execute(
                "INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at, verified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(user_id, event_key) DO NOTHING",
                params![user.id, def.name, key, hj, body, size, now, i64::from(verified)],
            )
        })?;
        Ok(true)
    }

    /// The next row to deliver for a user (the oldest not done).
    fn next_row(&self, user_id: &str) -> Result<Option<Row>> {
        self.db.with(|c| {
            c.query_row("SELECT id, channel, event_key, headers, body, at, tries, next_at, verified FROM channel_inbox WHERE user_id = ?1 AND done_at IS NULL ORDER BY id LIMIT 1", [user_id], |r| {
                Ok(Row { id: r.get(0)?, channel: r.get(1)?, key: r.get(2)?, headers: r.get(3)?, body: r.get(4)?, at: r.get(5)?, tries: r.get(6)?, next_at: r.get(7)?, verified: r.get::<_, i64>(8)? != 0 })
            })
            .optional()
        })
    }

    fn finish(&self, id: i64) -> Result<()> {
        let now = self.clock.now_ms();
        self.db.with(|c| c.execute("UPDATE channel_inbox SET done_at = ?1, body = x'', headers = '[]' WHERE id = ?2", params![now, id]))?;
        Ok(())
    }

    fn strikes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Strikes>> {
        self.wakes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Deliver what's held for `user`, in order, until it's all in or one must wait. → how long until the next try
    /// (None: nothing left, or the account's gone).
    pub async fn drain(&self, user: &UserRow) -> Result<Option<i64>> {
        if !self.opts.enabled || user.disabled != 0 {
            return Ok(None);
        }
        let _one = self.busy.lock().await;
        loop {
            let Some(row) = self.next_row(&user.id)? else { return Ok(None) };
            let now = self.clock.now_ms();
            if row.next_at > now {
                return Ok(Some(row.next_at - now)); // strictly in order: nothing passes a row being retried
            }
            if self.boxes.state(&user.id) != BoxState::Running {
                let w = self.strikes().get(&user.id).copied().unwrap_or_default();
                let cold = w.n >= self.opts.wake_strikes;
                let wait = if cold { w.at + self.opts.wake_gap_ms - now } else { 0 };
                if wait > 0 {
                    return Ok(Some(wait));
                }
                if self.boxes.ensure(&BoxUser::user(user), cold).await.is_err() {
                    return Ok(Some(self.opts.wake_retry_ms)); // full, or it wouldn't start: not the message's fault
                }
                self.strikes().insert(user.id.clone(), Strikes { n: w.n + 1, at: now });
                continue;
            }
            let (Some(port), Some(secret)) = (self.boxes.port(&user.id), self.boxes.secret(&user.id)) else { return Ok(Some(self.opts.retry_ms)) };
            let dropped: i64 = self.db.with(|c| c.query_row("SELECT dropped FROM channel_urls WHERE user_id = ?1 AND channel = ?2", params![user.id, row.channel], |r| r.get(0)).optional())?.unwrap_or(0);
            let d = Delivery { channel: row.channel.clone(), headers: serde_json::from_str(&row.headers).unwrap_or_default(), body: row.body.clone(), at: row.at, dropped, verified: row.verified, key: row.key.clone() };
            let status = {
                let _busy = self.boxes.begin(&user.id); // not stopped under it, and it isn't use
                self.deliver.deliver(port, &secret, &d, 30_000).await.map_or(0, |(s, _)| s)
            };
            let ok = (200..300).contains(&status);
            if ok {
                self.strikes().remove(&user.id);
                if let Some(f) = self.delivered.get() {
                    f(&user.id, &d);
                }
                if dropped > 0 {
                    self.db.with(|c| c.execute("UPDATE channel_urls SET dropped = max(0, dropped - ?1) WHERE user_id = ?2 AND channel = ?3", params![dropped, user.id, row.channel]))?;
                }
            }
            // 4xx: the box read it and said no (a bad signature, a stranger, the channel off): retrying can't help
            if ok || (400..500).contains(&status) {
                self.finish(row.id)?;
                continue;
            }
            let tries = row.tries + 1;
            if tries >= MAX_TRIES {
                self.finish(row.id)?;
                self.count(&user.id, &row.channel)?;
                continue;
            }
            let next = self.opts.retry_ms * 2i64.pow(u32::try_from(tries - 1).unwrap_or(0));
            self.db.with(|c| c.execute("UPDATE channel_inbox SET tries = ?1, next_at = ?2 WHERE id = ?3", params![tries, now + next, row.id]))?;
            return Ok(Some(next));
        }
    }

    /// Past their hour: gone. One that never got there counts as lost; a delivered one just stops guarding.
    pub fn sweep(&self) -> Result<usize> {
        let before = self.clock.now_ms() - self.opts.ttl_ms;
        let lost: Vec<(String, String)> = self.db.with(|c| c.prepare_cached("SELECT user_id, channel FROM channel_inbox WHERE at < ?1 AND done_at IS NULL")?.query_map([before], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())?;
        for (u, ch) in &lost {
            self.count(u, ch)?;
        }
        let n = self.db.with(|c| c.execute("DELETE FROM channel_inbox WHERE at < ?1", [before]))?;
        Ok(n)
    }

    /// True the first time a key comes by, for the hour a row lasts: a sender's retry stops here (a route's).
    pub fn first(&self, user_id: &str, key: &str) -> bool {
        let now = self.clock.now_ms();
        self.db
            .with(|c| c.execute("INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at, done_at) VALUES (?1, 'seen', ?2, '[]', x'', 0, ?3, ?3) ON CONFLICT(user_id, event_key) DO NOTHING", params![user_id, key, now]))
            .is_ok_and(|n| n > 0)
    }

    /// The users with something held (after a restart, each is drained).
    pub fn waiting(&self) -> Result<Vec<String>> {
        self.db.with(|c| c.prepare_cached("SELECT DISTINCT user_id FROM channel_inbox WHERE done_at IS NULL")?.query_map([], |r| r.get(0))?.collect())
    }
}

struct Row {
    id: i64,
    channel: String,
    key: String,
    headers: String,
    body: Vec<u8>,
    at: i64,
    tries: i64,
    next_at: i64,
    verified: bool,
}

/// Delivers into a box over loopback: `POST /api/cmd {cmd: "channels.inbound", args}` with the box's proxy secret,
/// the row's key as the Idempotency-Key (a retry of the same row runs once). The answer is the transport's.
#[derive(Debug, Default)]
pub struct HttpDeliver {
    pub client: reqwest::Client,
}

#[async_trait::async_trait]
impl Deliver for HttpDeliver {
    async fn deliver(&self, port: u16, secret: &str, d: &Delivery, timeout_ms: u64) -> std::result::Result<(u16, Value), String> {
        use base64::Engine as _;
        let args = json!({ "channel": d.channel, "headers": d.headers, "body": base64::engine::general_purpose::STANDARD.encode(&d.body), "at": d.at, "dropped": d.dropped, "verified": d.verified });
        let r = self
            .client
            .post(format!("http://127.0.0.1:{port}/api/cmd"))
            .header("x-wisp-proxy-secret", secret)
            .header("idempotency-key", sha256(&d.key))
            .json(&json!({ "cmd": "channels.inbound", "args": args }))
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        // the command answered: the transport's own status and body; else the edge's status
        Ok(match v.get("result") {
            Some(out) if status == 200 => (out.get("status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()).unwrap_or(200), out.get("body").cloned().unwrap_or(Value::Null)),
            _ => (status, v),
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
