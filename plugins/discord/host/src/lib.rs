//! wisp-discord: the Discord transport for wisp.channels (v1 `channels/discord.js`), on a computer: a gateway
//! connection, so wisp dials out and nothing has to reach this machine. Mention the bot in a server, or DM it, and
//! the message reads as the launcher's grammar (wisp.channels' flow); in a server the task answers in a thread made
//! on the message that asked, in a DM as replies. No privileged intent: a plain message in a thread carries no text,
//! so there you mention the bot (or reply to one of the task's messages).
//!
//! Only people linked by the code shown in wisp (`link <code>` in a DM) may speak, by their stable user id; a
//! stranger's DM gets one line, a stranger in a server silence. A message can't ask for more than Edits, and nothing
//! posted pings anyone, shows a link as something else, or unfurls. The wire's decisions are `wisp-discord-core`'s.
//!
//! Not here yet: `/wisp` and its autocomplete, buttons (interactions), a cloud box's interactions through the grid.

use std::sync::{Arc, Mutex, PoisonError, Weak};

mod conv;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::hub::WsFrame;
use wisp_channels_api::policy::{Gate, GateArgs, RateHit, RateLimit, Seen, gate};
use wisp_channels_api::scrub::{defuse, scrub_out, truncate};
use wisp_channels_api::views::{ActionKind, Msg, SessionView};
use wisp_channels_api::{ChannelHub, HttpRequest, Status, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_discord_core::gateway::{self, Conn, Me, Session, Step};
use wisp_discord_core::message;
use wisp_discord_core::{MAX_TEXT, RESUME_TRIES, SUPPRESS_EMBEDS, backoff_ms, invite_url, unmask};
use wisp_kernel::{CancellationToken, Manifest, Plugin, Result, Setup, WireError};

pub const NAME: &str = "discord";
const BACKOFF_MS: u64 = 2_000;
/// Messages of a task a reply can point at.
const MAX_IDS: usize = 20;
pub const STRANGER: &str = "This wisp only answers people linked to it. To link, send `link` and the code shown in wisp → Settings → Phone → Discord, here.";
pub const LINKED: &str = "✓ Linked to wisp. Mention me in a server, or write here, to say what you’d type in wisp.";
pub const WRONG_CODE: &str = "That code doesn’t match. Send `link` and the code shown in wisp → Settings → Phone → Discord.";
const FIX: &str = "Check the token in wisp → Settings → Phone → Discord.";

#[derive(Debug, Default)]
pub struct DiscordPlugin;

/// The transport on `hub`, as wisp.channels makes it (tests drive it on the api's test hub).
pub fn transport(hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
    Def.create(hub)
}

struct Def;
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        NAME
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new_cyclic(|this| Discord { this: this.clone(), hub, seen: Mutex::default(), limit: Mutex::default(), strangers: Mutex::new(RateLimit::new(3, 60_000)), me: Mutex::default(), session: Mutex::default() })
    }
    fn secrets(&self) -> &'static [&'static str] {
        &["token", "publicKey"]
    }
}

pub(crate) struct Discord {
    this: Weak<Discord>,
    pub hub: Arc<dyn ChannelHub>,
    seen: Mutex<Seen>,
    limit: Mutex<RateLimit>,
    strangers: Mutex<RateLimit>,
    pub me: Mutex<Option<Me>>,
    /// what a resume needs, across connections
    session: Mutex<Option<Session>>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// What leaves: no secrets, no pings, no masked links, one message.
pub fn discord_text(text: &str) -> String {
    truncate(&unmask(&defuse(&scrub_out(text, true).text)), MAX_TEXT)
}

/// A post: nobody pinged, no embeds; `reply`: the message it answers.
pub fn post_body(text: &str, reply: Option<&str>) -> Value {
    let mut b = json!({ "content": discord_text(text), "allowed_mentions": { "parse": [] }, "flags": SUPPRESS_EMBEDS });
    if let Some(r) = reply {
        b["message_reference"] = json!({ "message_id": r, "fail_if_not_exists": false });
    }
    b
}

/// A linked person's `link <code>`, compared whole.
pub fn code_matches(given: Option<&str>, want: &str) -> bool {
    let (g, w) = (given.unwrap_or_default().as_bytes(), want.as_bytes());
    !w.is_empty() && g.len() == w.len() && g.iter().zip(w).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

/// `link` or `link <code>`, from a DM's text.
pub fn link_code(text: &str) -> Option<Option<&str>> {
    let mut words = text.split_whitespace();
    if !words.next()?.eq_ignore_ascii_case("link") {
        return None;
    }
    let code = words.next();
    words.next().is_none().then_some(code)
}

impl Discord {
    pub(crate) fn cfg(&self) -> Value {
        self.hub.cfg(NAME)
    }
    fn mark(&self, error: Option<String>) {
        self.hub.mark(NAME, Status { ok: Some(error.is_none()), error, at: Some(self.hub.now_ms()), ..Status::default() });
    }

    /// One REST call. The token goes in a header; an error is only ever Discord's own words.
    pub(crate) async fn rest(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let base = std::env::var("WISP_DISCORD_API").unwrap_or_else(|_| "https://discord.com/api/v10".into());
        let url = format!("{}{path}", base.trim_end_matches('/'));
        let token = s(&self.cfg(), "token").to_owned();
        let req = match body {
            Some(b) => HttpRequest::post_json(url, b),
            None => HttpRequest::get(url),
        };
        let mut req = req.header("authorization", format!("Bot {token}")).header("user-agent", "DiscordBot (https://trywisp.dev, 1)").timeout(15_000);
        method.clone_into(&mut req.method);
        let r = self.hub.net().fetch(req).await.map_err(|e| WireError::unavailable(format!("Discord: {e}")))?;
        let j = r.json();
        if r.status == 401 {
            return Err(WireError::conflict(format!("Discord: {}. {FIX}", j.get("message").and_then(Value::as_str).unwrap_or("unauthorized"))));
        }
        if !(200..300).contains(&r.status) {
            return Err(WireError::unavailable(format!("Discord: {}", j.get("message").and_then(Value::as_str).map_or_else(|| r.status.to_string(), str::to_owned))));
        }
        Ok(j)
    }

    /// A post in `chat`, as a reply to `reply` when it isn't a task's own thread.
    pub(crate) async fn say(&self, chat: &str, reply: Option<&str>, text: &str) -> Result<Value> {
        self.rest("POST", &format!("/channels/{chat}/messages"), Some(&post_body(text, reply))).await
    }

    /// A reply to one of these messages reaches the task.
    pub(crate) fn link(&self, session: &str, id: &str) {
        let mut r = self.hub.remote_of(session).unwrap_or_default();
        let mut t = r.get(NAME).cloned().unwrap_or_else(|| json!({}));
        let mut ids: Vec<Value> = t["ids"].as_array().cloned().unwrap_or_default();
        ids.push(json!(id));
        let skip = ids.len().saturating_sub(MAX_IDS);
        t["ids"] = Value::Array(ids.into_iter().skip(skip).collect());
        r.insert(NAME.into(), t);
        self.hub.set_remote(session, r);
    }

    /// The task in this thread, or the one a reply points at.
    pub(crate) fn session_for(&self, chat: &str, reference: Option<&str>) -> Option<String> {
        self.hub
            .find_remote(&|r, _| {
                r.get(NAME).is_some_and(|t| (t["thread"] == true && s(t, "channel") == chat) || reference.is_some_and(|re| t["ids"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(re)))))
            })
            .into_iter()
            .next()
    }

    /// One connection, until it ends. Ok(true): Discord asked for another now. Err: why it won't come back.
    async fn listen(self: &Arc<Self>, url: &str, stop: &CancellationToken) -> std::result::Result<(bool, bool, u64), String> {
        let ws_url = format!("{}/?v=10&encoding=json", url.trim_end_matches('/'));
        let conn = self.hub.ws().connect(&ws_url).await.map_err(|e| format!("Discord: {e}"))?;
        let token = s(&self.cfg(), "token").to_owned();
        let mut c = Conn::new(&token, lock(&self.session).clone());
        let (mut ready, mut next_beat): (bool, Option<(u64, i64)>) = (false, None);
        let hello_by = self.hub.now_ms() + i64::try_from(self.hub.tune("discordHelloMs").unwrap_or(30_000)).unwrap_or(30_000);
        loop {
            let due = next_beat.map_or(hello_by, |(_, at)| at);
            let wait = u64::try_from(due - self.hub.now_ms()).unwrap_or(0).max(1);
            let frame = tokio::select! {
                biased;
                () = stop.cancelled() => {
                    conn.close(1000).await;
                    return Ok((false, ready, 0));
                }
                f = conn.recv() => f,
                () = self.hub.sleep(wait) => {
                    let Some((every, _)) = next_beat else {
                        conn.close(4000).await;
                        return Err("Discord never said hello.".into());
                    };
                    let Some(b) = c.beat() else {
                        conn.close(4000).await;
                        return Err("Discord stopped answering.".into());
                    };
                    let _ = conn.send(b).await;
                    next_beat = Some((every, self.hub.now_ms() + i64::try_from(every).unwrap_or(i64::MAX / 4)));
                    continue;
                }
            };
            let text = match frame {
                Some(WsFrame::Text(t)) => t,
                Some(WsFrame::Binary(_)) => continue,
                Some(WsFrame::Close(code, why)) => {
                    let (fatal, over) = gateway::closed(code);
                    if over {
                        *lock(&self.session) = None;
                    }
                    if let Some(f) = fatal {
                        return Err(f.into());
                    }
                    let why = if why.is_empty() { "The connection to Discord dropped.".to_owned() } else { why };
                    self.mark(Some(why));
                    return Ok((false, ready, 0));
                }
                None => return Ok((false, ready, 0)),
            };
            let invalid = self.hub.tune("discordInvalidMs").unwrap_or(1_000) * u64::from(1 + self.hub.random_int(0, 5));
            for step in c.frame(&text, invalid) {
                match step {
                    Step::Send(t) => {
                        let _ = conn.send(t).await;
                    }
                    Step::Beat(every) => {
                        // the first beat after a random part of it (Discord's jitter)
                        let first = every * u64::from(self.hub.random_int(1, 1000)) / 1000;
                        next_beat = Some((every, self.hub.now_ms() + i64::try_from(first).unwrap_or(0)));
                    }
                    Step::Ready(me) => {
                        ready = true;
                        *lock(&self.me) = Some(me);
                        self.mark(None);
                    }
                    Step::Resumed => {
                        ready = true;
                        self.mark(None);
                    }
                    Step::Message(d) => {
                        let me = self.clone();
                        self.hub.spawn(Box::pin(async move {
                            if let Err(e) = me.message(&d).await {
                                me.hub.warn(&format!("discord: {}", e.message));
                            }
                        }));
                    }
                    Step::Close { again, wait_ms } => {
                        lock(&self.session).clone_from(&c.session);
                        conn.close(4000).await;
                        return Ok((again, ready, wait_ms));
                    }
                }
            }
            lock(&self.session).clone_from(&c.session);
        }
    }

    /// A person's message: the door (linked people only), then the grammar.
    async fn message(self: &Arc<Self>, d: &Value) -> Result<()> {
        let me_id = lock(&self.me).as_ref().map(|m| m.id.clone()).unwrap_or_default();
        let Ok(m) = message::message(d, &me_id) else { return Ok(()) };
        let cfg = self.cfg();
        let text = wisp_channels_api::markup::strip_formatting(&m.content, wisp_channels_api::markup::Markup::Discord, &me_id);
        if m.dm
            && let Some(code) = link_code(&text)
        {
            if !lock(&self.seen).first(&format!("link:{}", m.id)) || !matches!(lock(&self.strangers).hit(&m.author, self.hub.now_ms()), RateHit::Ok) {
                return Ok(());
            }
            if !code_matches(code, s(&cfg, "linkCode")) {
                self.say(&m.channel, Some(&m.id), WRONG_CODE).await?;
                return Ok(());
            }
            let mut c = cfg.clone();
            let mut senders: Vec<Value> = c.get("senders").and_then(Value::as_array).cloned().unwrap_or_default();
            if !senders.iter().any(|x| x.as_str() == Some(m.author.as_str())) {
                senders.push(json!(m.author));
            }
            c["senders"] = Value::Array(senders);
            self.hub.set_cfg(NAME, c);
            self.say(&m.channel, Some(&m.id), LINKED).await?;
            return Ok(());
        }
        let senders: Vec<String> = cfg.get("senders").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let g = {
            let (mut seen, mut limit) = (lock(&self.seen), lock(&self.limit));
            let at_s = message::snowflake_ms(&m.id).map(|ms| ms / 1000);
            gate(GateArgs { sender: Some(&m.author), senders: &senders, id: Some(&m.id), at_s, seen: Some(&mut seen), limit: Some(&mut limit), now_ms: self.hub.now_ms(), dm: m.dm, stranger_line: STRANGER, ..GateArgs::default() })
        };
        if let Gate::Refused { reply, why } = g {
            self.hub.phone().count("refused", Some(&format!("{why:?}").to_lowercase()));
            let once = m.dm && matches!(lock(&self.strangers).hit(&m.author, self.hub.now_ms()), RateHit::Ok);
            if let Some(r) = reply.filter(|_| once) {
                self.say(&m.channel, Some(&m.id), &r).await?;
            }
            return Ok(());
        }
        let phone = self.hub.phone();
        let ctx = phone.context().await?;
        let typed = if text.is_empty() { "help".to_owned() } else if text.to_lowercase().starts_with("new ") || text.eq_ignore_ascii_case("new") { format!("/{text}") } else { text };
        let session = self.session_for(&m.channel, m.reference.as_deref());
        let c = conv::DiscordConv { discord: self, phone, ctx, m: &m, target: Mutex::new((m.channel.clone(), Some(m.id.clone()))), in_thread: Mutex::new(false) };
        self.hub.converse(&c, &typed, session.as_deref(), None).await.map(|_| ())
    }
}

#[async_trait]
impl Transport for Discord {
    fn name(&self) -> &str {
        NAME
    }
    fn ready(&self) -> bool {
        let c = self.cfg();
        c["enabled"] == true && !s(&c, "token").is_empty() && !self.hub.grid().in_box()
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }

    async fn start(&self, stop: CancellationToken) {
        if !self.ready() {
            return;
        }
        let Some(me) = self.this.upgrade() else { return };
        let base = self.hub.tune("discordBackoffMs").unwrap_or(BACKOFF_MS);
        let mut fails = 0u32;
        while !stop.is_cancelled() {
            let resume = lock(&self.session).as_ref().map(|s| s.url.clone()).filter(|u| !u.is_empty());
            let url = match resume {
                Some(u) => Ok(u),
                None => self.rest("GET", "/gateway/bot", None).await.map(|g| s(&g, "url").to_owned()).map_err(|e| e.message),
            };
            let (now, wait) = match url {
                Err(e) if e.contains(FIX) => {
                    self.mark(Some(e));
                    return;
                }
                Err(e) => {
                    self.mark(Some(e));
                    (false, 0)
                }
                Ok(u) => match me.listen(&u, &stop).await {
                    Ok((again, ready, wait)) => {
                        if ready {
                            fails = 0;
                        }
                        (again, wait)
                    }
                    Err(fatal) if fatal.starts_with("Discord refused") || fatal.contains("Update wisp") || fatal.contains("sharding") || fatal.contains("Developer Portal") => {
                        self.mark(Some(fatal));
                        return;
                    }
                    Err(e) => {
                        self.mark(Some(e));
                        (false, 0)
                    }
                },
            };
            if stop.is_cancelled() {
                return;
            }
            if now {
                continue;
            }
            fails += 1;
            if fails >= RESUME_TRIES {
                *lock(&self.session) = None; // its URL may be gone for good: the gateway's, then
            }
            tokio::select! {
                () = stop.cancelled() => return,
                () = self.hub.sleep(wait.max(backoff_ms(base, fails))) => {}
            }
        }
    }

    fn reports(&self, s: Option<&SessionView>) -> bool {
        s.and_then(|s| self.hub.started_from(&s.id)).is_some_and(|(c, _)| c == NAME)
    }

    /// Only for a task started here: its report in its thread, or as a reply to its last message.
    async fn publish(&self, msg: &Msg, sv: Option<&SessionView>) -> Result<()> {
        let Some(sv) = sv else { return Ok(()) };
        let Some(t) = self.hub.remote_of(&sv.id).and_then(|r| r.get(NAME).cloned()) else { return Ok(()) };
        let chat = s(&t, "channel").to_owned();
        let reply = (t["thread"] != true).then(|| t["ids"].as_array().and_then(|a| a.last()).and_then(Value::as_str).map(str::to_owned)).flatten();
        let by = self.hub.started_from(&sv.id).and_then(|(_, by)| by);
        let title = match by.as_deref() {
            Some(b) if !msg.title.starts_with(&format!("{b}: ")) => format!("{b}: {}", msg.title),
            _ => msg.title.clone(),
        };
        let choices: Vec<&str> = msg.actions.iter().filter(|a| a.kind != ActionKind::Done).map(|a| a.label.as_str()).collect();
        let here = if t["thread"] == true || chat.is_empty() { "Mention me here to answer or follow up." } else { "Reply to this message to answer or follow up." };
        let text = [title, msg.text.clone(), if choices.is_empty() { String::new() } else { format!("Choices: {}", choices.join(" · ")) }, here.to_owned()].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
        let sent = self.say(&chat, reply.as_deref(), &text).await?;
        if let Some(id) = sent.get("id").and_then(Value::as_str) {
            self.link(&sv.id, id);
        }
        self.hub.phone().count("report", Some("full"));
        Ok(())
    }

    /// `GET /api/remote/discord/invite`: the link that adds the bot to a server.
    async fn extra(&self, what: &str) -> Result<Value> {
        match what {
            "invite" => {
                let app = Some(s(&self.cfg(), "appId").to_owned()).filter(|a| !a.is_empty()).or_else(|| lock(&self.me).as_ref().and_then(|m| m.app_id.clone()));
                let app = app.ok_or_else(|| WireError::conflict("Turn Discord on first: wisp learns the application from Discord."))?;
                Ok(json!({ "url": invite_url(&app) }))
            }
            _ => Err(WireError::not_found(format!("Discord has no {what}"))),
        }
    }
}

impl Plugin for DiscordPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let d: Arc<dyn TransportDef> = Arc::new(Def);
        s.contribute(&TRANSPORTS, d);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(DiscordPlugin.manifest().id, "wisp.discord");
    }

    #[test]
    fn what_leaves_pings_nobody_and_shows_every_link_as_it_is() {
        let b = post_body("@everyone see [docs](https://x)", Some("9"));
        assert!(!b["content"].as_str().unwrap_or_default().contains("](") && b["allowed_mentions"]["parse"] == json!([]));
        assert_eq!((b["flags"].as_u64(), b["message_reference"]["message_id"].as_str()), (Some(SUPPRESS_EMBEDS), Some("9")));
        assert_eq!(link_code("link ab12"), Some(Some("ab12")));
        assert_eq!(link_code("Link"), Some(None));
        assert_eq!(link_code("link a b"), None);
        assert!(code_matches(Some("ab12"), "ab12") && !code_matches(Some("ab1"), "ab12") && !code_matches(Some(""), ""));
    }
}
