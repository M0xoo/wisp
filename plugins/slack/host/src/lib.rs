//! wisp-slack: the Slack transport for wisp.channels (v1 `channels/slack.js`), on a computer: Socket Mode, so wisp
//! dials out and nothing has to reach this machine. `@wisp in api with opus plan: fix it` in a channel, or a DM to
//! the bot, reads as the launcher's grammar (wisp.channels' flow, `ChannelHub::converse`) and answers in a thread;
//! the task's report goes back there. Only people linked by the code shown in wisp (`link <code>` in a DM) may
//! speak, by their stable user id; a stranger's DM gets one line and then silence, a stranger in a channel gets
//! silence. A message can't ask for more than Edits. Every envelope is acked the moment it arrives.
//!
//! The wire's decisions are `wisp-slack-core`'s; every request goes through the hub's `Net` and its `Ws`.
//! One turn at a time per thread (`turns`), side by side across threads.

use std::sync::{Arc, Mutex, PoisonError, Weak};

mod click;
mod conv;
mod turns;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::hub::WsFrame;
use wisp_channels_api::policy::{Gate, GateArgs, RateHit, RateLimit, Seen, gate};
use wisp_channels_api::scrub::{defuse, scrub_out};
use wisp_channels_api::transport::{Headers, InboundOpts, InboundResult, header};
use wisp_channels_api::views::{Msg, SessionView};
use wisp_channels_api::{ChannelHub, HttpRequest, Status, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_kernel::{BoxFuture, CancellationToken, Manifest, Plugin, Result, Setup, WireError};
use wisp_slack_core::socket::{Dial, Listen, Next, Step};
use wisp_slack_core::{SlackError, event, mrkdwn, post, sign};

pub const NAME: &str = "slack";
/// The first wait after a failed dial (tests turn it down with `slackBackoffMs`).
const BACKOFF_MS: u64 = 2_000;
/// Slack's hello comes within two of these (the keep-alive beat, `slackPingMs` in tests).
const PING_MS: u64 = 30_000;
pub const STRANGER: &str =
    "This wisp only answers people linked to it. To link, send `link` and the code shown in wisp → Settings → Phone → Slack, here.";
pub const LINKED: &str = "✓ Linked to wisp. Say what you’d type in wisp, here or with @wisp in a channel.";
pub const WRONG_CODE: &str = "That code doesn’t match. Send `link` and the code shown in wisp → Settings → Phone → Slack.";

#[derive(Debug, Default)]
pub struct SlackPlugin;

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
        Arc::new_cyclic(|this| Slack {
            this: this.clone(),
            hub,
            seen: Mutex::default(),
            limit: Mutex::default(),
            strangers: Mutex::new(RateLimit::new(3, 60_000)),
            me: Mutex::default(),
            turns: turns::Turns::default(),
        })
    }
    fn secrets(&self) -> &'static [&'static str] {
        &["botToken", "appToken", "signingSecret", "linkCode"]
    }
}

/// Who this bot is (`auth.test`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Me {
    pub user: String,
    pub name: String,
}

pub(crate) struct Slack {
    /// itself, for the work its socket spawns
    this: Weak<Slack>,
    pub hub: Arc<dyn ChannelHub>,
    seen: Mutex<Seen>,
    limit: Mutex<RateLimit>,
    /// a line each, and then silence
    strangers: Mutex<RateLimit>,
    pub me: Mutex<Option<Me>>,
    /// one turn at a time per thread
    turns: turns::Turns,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// What leaves, in Slack's markup: no secrets, no @-pings, `&<>` escaped, within Slack's length.
pub fn slack_text(text: &str) -> String {
    mrkdwn::fit(&defuse(&scrub_out(text, true).text))
}

/// A post in a thread; unfurling fetches URLs an agent wrote, so it's off.
pub fn body(chat: &str, ts: &str, text: &str) -> Value {
    json!({ "channel": chat, "thread_ts": ts, "text": text, "mrkdwn": true, "parse": "none", "link_names": false, "unfurl_links": false, "unfurl_media": false })
}

/// A linked person's `link <code>`: the code shown in wisp, compared whole.
pub fn code_matches(given: Option<&str>, want: &str) -> bool {
    let (g, w) = (given.unwrap_or_default().as_bytes(), want.as_bytes());
    !w.is_empty() && g.len() == w.len() && g.iter().zip(w).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

impl Slack {
    fn cfg(&self) -> Value {
        self.hub.cfg(NAME)
    }
    fn mark(&self, error: Option<String>) {
        self.hub.mark(NAME, Status { ok: Some(error.is_none()), error, at: Some(self.hub.now_ms()), ..Status::default() });
    }

    /// One Web API call. Tokens go in a header; an error is only ever Slack's own short code.
    pub(crate) async fn call(&self, method: &str, body: &Value, token: &str) -> std::result::Result<Value, SlackError> {
        let base = std::env::var("WISP_SLACK_API").unwrap_or_else(|_| "https://slack.com/api".into());
        let url = format!("{}/{method}", base.trim_end_matches('/'));
        let req = HttpRequest::post_json(url, body).header("authorization", format!("Bearer {token}")).timeout(15_000);
        let r = self.hub.net().fetch(req).await.map_err(|e| SlackError::Net(format!("Slack: {e}")))?;
        if r.status == 429 {
            let retry_after_s =
                r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("retry-after")).and_then(|(_, v)| v.parse().ok()).unwrap_or(1);
            return Err(SlackError::RateLimited { retry_after_s });
        }
        let j = r.json();
        if j.get("ok") != Some(&Value::Bool(true)) {
            let code = j.get("error").and_then(Value::as_str).map_or_else(|| r.status.to_string(), str::to_owned);
            return Err(SlackError::Api(code));
        }
        Ok(j)
    }

    pub(crate) async fn post(&self, chat: &str, ts: &str, text: &str) -> Result<Value> {
        let token = s(&self.cfg(), "botToken").to_owned();
        self.call("chat.postMessage", &body(chat, ts, &slack_text(text)), &token).await.map_err(WireError::from)
    }

    async fn who_am_i(&self, token: &str) -> std::result::Result<(), SlackError> {
        let me = self.call("auth.test", &json!({}), token).await?;
        *lock(&self.me) = Some(Me {
            user: s(&me, "user_id").to_owned(),
            name: Some(s(&me, "user")).filter(|n| !n.is_empty()).unwrap_or("wisp").to_owned(),
        });
        Ok(())
    }

    /// One connection, until it ends, Slack asks for another, or `stop`.
    async fn listen(
        self: &Arc<Self>,
        url: &str,
        stop: &CancellationToken,
    ) -> std::result::Result<wisp_slack_core::socket::End, SlackError> {
        let conn = self.hub.ws().connect(url).await.map_err(|e| SlackError::Net(format!("Slack: {e}")))?;
        let beat = self.hub.tune("slackPingMs").unwrap_or(PING_MS);
        let mut l = Listen::new(self.hub.now_ms(), beat);
        loop {
            // frames first (one that came in is read before any timer); a timer only while waiting for the hello
            let frame = if let Some(d) = l.deadline() {
                let wait = u64::try_from(d - self.hub.now_ms()).unwrap_or(0).max(1);
                tokio::select! {
                    biased;
                    () = stop.cancelled() => {
                        conn.close(1000).await;
                        return Ok(l.end());
                    }
                    f = conn.recv() => f,
                    () = self.hub.sleep(wait) => {
                        if let Some(why) = l.tick(self.hub.now_ms()) {
                            conn.close(4000).await;
                            return Err(SlackError::Net(why.to_owned()));
                        }
                        continue;
                    }
                }
            } else {
                // after the hello, a beat: nothing from Slack since the last one and the socket is gone (a laptop
                // that slept leaves one that looks open)
                tokio::select! {
                    biased;
                    () = stop.cancelled() => {
                        conn.close(1000).await;
                        return Ok(l.end());
                    }
                    f = conn.recv() => f,
                    () = self.hub.sleep(beat) => {
                        if conn.ping().await {
                            continue;
                        }
                        conn.close(4000).await;
                        return Err(SlackError::Net("Slack stopped answering.".into()));
                    }
                }
            };
            let text = match frame {
                Some(WsFrame::Text(t)) => t,
                Some(WsFrame::Binary(_)) => continue,
                Some(WsFrame::Close(..)) | None => return Ok(l.end()),
            };
            for step in l.frame(&text) {
                match step {
                    Step::Send(ack) => {
                        let _ = conn.send(ack).await;
                    }
                    Step::Hello => self.mark(None),
                    Step::Close => {
                        conn.close(1000).await;
                        return Ok(l.end());
                    }
                    Step::Event(payload) => {
                        let me = self.clone();
                        self.hub.spawn(Box::pin(async move {
                            let key = event::thread_key(&payload).unwrap_or_default();
                            if let Err(e) = me.turns.queue(&key, me.event(&payload)).await {
                                me.hub.warn(&format!("slack: {}", e.message));
                            }
                        }));
                    }
                    Step::Click(payload) => {
                        let me = self.clone();
                        self.hub.spawn(Box::pin(async move {
                            let key = event::click(&payload).map(|c| format!("{}:{}", c.chat, c.root)).unwrap_or_default();
                            if let Err(e) = me.turns.queue(&key, me.click(&payload)).await {
                                me.hub.warn(&format!("slack: {}", e.message));
                            }
                        }));
                    }
                }
            }
        }
    }

    /// A message: through the door (linked people only), then the grammar.
    async fn event(self: &Arc<Self>, payload: &Value) -> Result<()> {
        let me_user = lock(&self.me).as_ref().map(|m| m.user.clone());
        let Ok(m) = event::message(payload, me_user.as_deref()) else { return Ok(()) };
        let cfg = self.cfg();
        let text = event::strip_formatting(&m.text, me_user.as_deref());
        let root = m.root().to_owned();
        // `link <code>` in a DM: the code shown in wisp links this person
        if m.dm
            && let Some(code) = event::link_code(&text)
        {
            if !lock(&self.seen).first(&format!("link:{}", m.ids().join(","))) {
                return Ok(());
            }
            if !matches!(lock(&self.strangers).hit(&m.user, self.hub.now_ms()), RateHit::Ok) {
                return Ok(());
            }
            if !code_matches(code, s(&cfg, "linkCode")) {
                self.post(&m.channel, &root, WRONG_CODE).await?;
                return Ok(());
            }
            let mut c = cfg.clone();
            let mut senders: Vec<Value> = c.get("senders").and_then(Value::as_array).cloned().unwrap_or_default();
            if !senders.iter().any(|x| x.as_str() == Some(m.user.as_str())) {
                senders.push(json!(m.user));
            }
            c["senders"] = Value::Array(senders);
            self.hub.set_cfg(NAME, c);
            self.post(&m.channel, &root, LINKED).await?;
            return Ok(());
        }
        let senders: Vec<String> =
            cfg.get("senders").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let g = {
            let (mut seen, mut limit) = (lock(&self.seen), lock(&self.limit));
            let id = m.ids().join(",");
            #[allow(clippy::cast_possible_truncation)]
            let at_s = m.at_s().map(|t| t as i64);
            gate(GateArgs {
                sender: Some(&m.user),
                senders: &senders,
                id: Some(&id),
                at_s,
                seen: Some(&mut seen),
                limit: Some(&mut limit),
                now_ms: self.hub.now_ms(),
                dm: m.dm,
                stranger_line: STRANGER,
                ..GateArgs::default()
            })
        };
        if let Gate::Refused { reply, why } = g {
            self.hub.phone().count("refused", Some(&format!("{why:?}").to_lowercase()));
            let once = m.dm && matches!(lock(&self.strangers).hit(&m.user, self.hub.now_ms()), RateHit::Ok);
            if let Some(r) = reply.filter(|_| once) {
                self.post(&m.channel, &root, &r).await?;
            }
            return Ok(());
        }
        let phone = self.hub.phone();
        let ctx = phone.context().await?;
        // Slack keeps a leading / for itself: `new …` is `/new …`
        let typed = if text.is_empty() {
            "help".to_owned()
        } else if text.to_lowercase().starts_with("new ") || text.eq_ignore_ascii_case("new") {
            format!("/{text}")
        } else {
            text
        };
        let session = m.thread_ts.as_ref().and_then(|_| self.thread_of(&m.channel, &root));
        let c = conv::SlackConv { slack: self, phone, ctx, m: &m, root: root.clone() };
        self.hub.converse(&c, &typed, session.as_deref(), None).await.map(|_| ())
    }

    /// Who this bot is isn't known yet (a box that just woke).
    fn lock_me_unknown(&self) -> bool {
        lock(&self.me).is_none()
    }

    /// The task this thread belongs to (the newest that started here).
    pub(crate) fn thread_of(&self, chat: &str, ts: &str) -> Option<String> {
        self.hub.find_remote(&|r, _| r.get(NAME).is_some_and(|t| s(t, "channel") == chat && s(t, "ts") == ts)).into_iter().next()
    }
}

#[async_trait]
impl Transport for Slack {
    fn name(&self) -> &str {
        NAME
    }
    /// On a computer: the bot and app tokens (Socket Mode). On a cloud box: the bot token and the signing secret
    /// (Slack posts its events to the box's URL on the grid).
    fn ready(&self) -> bool {
        let c = self.cfg();
        let other = if self.hub.grid().in_box() { "signingSecret" } else { "appToken" };
        c["enabled"] == true && !s(&c, "botToken").is_empty() && !s(&c, other).is_empty()
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }

    async fn start(&self, stop: CancellationToken) {
        if !self.ready() {
            return;
        }
        let Some(me) = self.this.upgrade() else { return };
        // a box sleeps, and a socket would go with it: Slack calls the box's URL instead (`inbound`)
        if self.hub.grid().in_box() {
            let bot = s(&self.cfg(), "botToken").to_owned();
            match me.who_am_i(&bot).await {
                Ok(()) => self.mark(None),
                Err(e) => self.mark(Some(e.line())),
            }
            return;
        }
        let base = self.hub.tune("slackBackoffMs").unwrap_or(BACKOFF_MS);
        let mut dial = Dial::default();
        while !stop.is_cancelled() {
            let cfg = self.cfg();
            let (bot, app) = (s(&cfg, "botToken").to_owned(), s(&cfg, "appToken").to_owned());
            let tried = async {
                me.who_am_i(&bot).await?;
                let open = me.call("apps.connections.open", &json!({}), &app).await?;
                me.listen(s(&open, "url"), &stop).await
            }
            .await;
            if stop.is_cancelled() {
                return;
            }
            let next = match tried {
                Ok(end) => {
                    if end.dropped() {
                        self.mark(Some("The connection to Slack dropped.".into()));
                    }
                    dial.ended(&end, base)
                }
                Err(e) => {
                    self.mark(Some(e.line()));
                    dial.failed(&e, base)
                }
            };
            match next {
                Next::Now => {}
                Next::Wait(ms) => tokio::select! {
                    () = stop.cancelled() => return,
                    () = self.hub.sleep(ms) => {}
                },
                Next::Stop(line) => {
                    self.mark(Some(line));
                    return;
                }
            }
        }
    }

    fn reports(&self, s: Option<&SessionView>) -> bool {
        s.and_then(|s| self.hub.started_from(&s.id)).is_some_and(|(c, _)| c == NAME)
    }

    /// Only for a task started here: its report in its thread.
    async fn publish(&self, msg: &Msg, sv: Option<&SessionView>) -> Result<()> {
        let Some(sv) = sv else { return Ok(()) };
        let Some(t) = self.hub.remote_of(&sv.id).and_then(|r| r.get(NAME).cloned()) else { return Ok(()) };
        let (chat, ts) = (s(&t, "channel").to_owned(), s(&t, "ts").to_owned());
        let by = self.hub.started_from(&sv.id).and_then(|(_, by)| by);
        let choices: Vec<String> =
            msg.actions.iter().filter(|a| !matches!(a.kind, wisp_channels_api::views::ActionKind::Done)).map(|a| a.label.clone()).collect();
        let me = lock(&self.me).as_ref().map(|m| m.name.clone());
        let text = post::report(&msg.title, &msg.text, &choices, by.as_deref(), chat.starts_with('D'), me.as_deref());
        let hub = self.hub.clone();
        let buttons = post::buttons(&click::choices(msg, sv, &|k, r, i| hub.sign(&sv.id, k, r, i)));
        let token = s(&self.cfg(), "botToken").to_owned();
        let plain = body(&chat, &ts, &slack_text(&text));
        if buttons.is_empty() {
            self.call("chat.postMessage", &plain, &token).await?;
        } else if let Err(e) = self.call("chat.postMessage", &post::with_buttons(plain.clone(), buttons), &token).await {
            if !e.code().is_some_and(click::no_blocks) {
                return Err(e.into());
            }
            self.call("chat.postMessage", &plain, &token).await?;
        }
        self.hub.phone().count("report", Some("full"));
        Ok(())
    }

    /// An event Slack posted to this cloud box's URL, held by the grid (v1 slack.js `inbound`): its signature
    /// checked with the signing secret against when the grid took it (a body sent again later is old), a repeat
    /// dropped by its event id, then the same path as a socket's event, after the answer went.
    async fn inbound(&self, raw: &[u8], headers: &Headers, opts: InboundOpts) -> InboundResult {
        let answer = |status: u16, body: Value| InboundResult { status, body, after: None };
        let c = self.cfg();
        if c["enabled"] != true || self.hub.grid().grid().is_none() {
            return answer(409, json!({ "error": "Slack isn’t on here." }));
        }
        let j: Value = serde_json::from_slice(raw).unwrap_or(Value::Null);
        let checking = j["type"] == "url_verification";
        let now = self.hub.now_ms();
        let taken = if opts.at_ms > 0 { opts.at_ms.min(now) } else { now };
        if !opts.verified {
            let secret = s(&c, "signingSecret");
            let checked = if secret.is_empty() {
                Err(SlackError::Signature(sign::MISSING))
            } else {
                sign::verify(secret, raw, header(headers, "x-slack-request-timestamp"), header(headers, "x-slack-signature"), taken)
            };
            if let Err(e) = checked {
                // wisp is open: a wrong secret is the likeliest slip in setup
                if checking {
                    self.mark(Some(sign::WRONG.into()));
                }
                return answer(403, json!({ "error": e.line() }));
            }
        }
        if checking {
            self.mark(None);
            return answer(200, json!({ "challenge": s(&j, "challenge").chars().take(512).collect::<String>() }));
        }
        if j["type"] != "event_callback" {
            return answer(200, json!({ "ok": true }));
        }
        if !lock(&self.seen).first(&format!("inbound:{}", s(&j, "event_id"))) {
            return answer(200, json!({ "ok": true, "seen": true }));
        }
        let Some(me) = self.this.upgrade() else { return answer(503, json!({ "error": "Slack is stopping." })) };
        let after: BoxFuture<'static, ()> = Box::pin(async move {
            if me.lock_me_unknown() {
                let bot = s(&me.cfg(), "botToken").to_owned();
                let _ = me.who_am_i(&bot).await;
            }
            let key = event::thread_key(&j).unwrap_or_default();
            if let Err(e) = me.turns.queue(&key, me.event(&j)).await {
                me.hub.warn(&format!("slack: {}", e.message));
            }
        });
        InboundResult { status: 200, body: json!({ "ok": true }), after: Some(after) }
    }

    /// `GET /api/remote/slack/manifest`: the app to create at api.slack.com/apps → From a manifest.
    async fn extra(&self, what: &str) -> Result<Value> {
        match what {
            "manifest" => Ok(post::manifest(None)),
            _ => Err(WireError::not_found(format!("Slack has no {what}"))),
        }
    }
}

impl Plugin for SlackPlugin {
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
        assert_eq!(SlackPlugin.manifest().id, "wisp.slack");
    }

    /// v1 slack.js: what leaves pings nobody and can't be read as Slack's markup.
    #[test]
    fn what_leaves_pings_nobody_and_a_link_code_must_match_whole() {
        assert_eq!(slack_text("<!channel> a & b"), "&lt;\u{200b}!channel&gt; a &amp; b", "defused, then escaped");
        assert!(code_matches(Some("ab12"), "ab12"));
        assert!(!code_matches(Some("ab1"), "ab12"), "a prefix isn't the code");
        assert!(!code_matches(Some(""), ""), "no code set: nobody links");
        assert!(!code_matches(None, "ab12"));
        let b = body("C1", "1.2", "hi");
        assert_eq!(
            (b["thread_ts"].as_str(), b["unfurl_links"].as_bool(), b["link_names"].as_bool()),
            (Some("1.2"), Some(false), Some(false))
        );
    }
}
