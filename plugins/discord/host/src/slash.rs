//! `/wisp`, its autocomplete and the report's buttons (v1 discord.js `#register`, `#fromInteraction`, `#choices`,
//! `#fromButton`, `inbound`, `#overHttp`). On a computer they come down the gateway and are answered by REST; on a
//! cloud wisp Discord posts them to the box's URL on the grid, which answers in Discord's three seconds ("thinking"
//! for `/wisp`, "seen" for a press) and holds them for the box; the box checks Discord's signature itself, with the
//! application's public key, and goes on from that answer. Only people linked get anything: a stranger's keystroke
//! gets an empty list, a stranger's press nothing, a stranger in a server silence.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_channels_api::policy::{Gate, GateArgs, RateHit, allowed, gate};
use wisp_channels_api::views::{ActArgs, ActionKind, Msg, SessionView, Signed};
use wisp_channels_api::{ChannelCtx, Headers, InboundOpts, InboundResult, Mode, header};
use wisp_discord_core::interaction::{self as ix, Interaction, Kind};
use wisp_discord_core::message::{Message, snowflake_ms};
use wisp_discord_core::{SUPPRESS_EMBEDS, interaction::EPHEMERAL};
use wisp_kernel::Result;

use crate::{Discord, LINKED, NAME, STRANGER, WRONG_CODE, code_matches, discord_text, link_code, lock, s};

pub const DEAD_BUTTON: &str = "That button doesn’t work any more.";
pub const IN_WORDS: &str = "Say that in words here, so it runs in Edits at most.";
pub const WENT_WRONG: &str = "wisp hit an error answering that. Check in wisp before you try again.";
pub const STRANGER_BOX: &str = "This wisp only answers people linked to it. To link, use `/wisp` here with `link` and the code shown in wisp → Settings → Phone → Discord.";
pub const NO_HUB: &str = "Discord can’t reach this wisp: its grid doesn’t hold messages for it. Set Discord up on a computer that stays on.";

/// The ids held interactions were seen by, kept in the config (a box forgets when it sleeps), by age.
const SEEN_KEY: &str = "seenHeld";

impl Discord {
    /// `/wisp`, put once per application and shape (kept in the config: a box wakes often and forgets).
    pub(crate) async fn register(&self, app: &str) -> Result<()> {
        let in_box = self.hub.grid().in_box();
        let command = ix::slash_command(in_box);
        let mark = format!("{app}:{}", command.to_string().len());
        if app.is_empty() || s(&self.cfg(), "commandsFor") == mark {
            return Ok(());
        }
        self.rest("PUT", &format!("/applications/{app}/commands"), Some(&json!([command]))).await?;
        let mut c = self.cfg();
        c["commandsFor"] = json!(mark);
        self.hub.set_cfg(NAME, c);
        Ok(())
    }

    /// On a cloud wisp nothing stays open: each start, the way in (the grid's URL, shown in Settings for the
    /// Developer Portal), the application checked against the key pasted, and `/wisp` registered.
    pub(crate) async fn over_http(&self) {
        let grid = self.hub.grid();
        let Some(b) = grid.grid() else { return };
        // the grid checks every interaction's signature with this key before it holds or wakes anything
        match grid.set_channel_key(&b, NAME, s(&self.cfg(), "publicKey").trim(), &[]).await {
            Ok(true) => {}
            Ok(false) => return self.mark_down(NO_HUB),
            Err(e) => return self.mark_down(&e.message),
        }
        let found = match grid.channel_url(&b, NAME, None, false).await {
            Ok(Some(f)) => f,
            Ok(None) => return self.mark_down(NO_HUB),
            Err(e) => return self.mark_down(&e.message),
        };
        if let Some(n) = found.dropped.filter(|n| *n > 0) {
            crate::Transport::dropped(self, n).await;
        }
        let mut c = self.cfg();
        if let Some(url) = found.url.filter(|u| c["endpoint"].as_str() != Some(u.as_str())) {
            c["endpoint"] = json!(url);
            self.hub.set_cfg(NAME, c.clone());
            self.hub.changed();
        }
        let app = match self.rest("GET", "/oauth2/applications/@me", None).await {
            Ok(a) => a,
            Err(e) => return self.mark_down(&e.message),
        };
        let real = s(&app, "verify_key").to_lowercase();
        if !real.is_empty() && real != s(&c, "publicKey").trim().to_lowercase() {
            let end: String = real.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
            return self.mark_down(&format!("The public key doesn’t match this application: Discord’s ends in {end}. Copy it again from the Developer Portal → General Information."));
        }
        let id = s(&app, "id").to_owned();
        if !id.is_empty() && s(&c, "appId") != id {
            c["appId"] = json!(id);
            self.hub.set_cfg(NAME, c);
        }
        match self.register(&id).await {
            Ok(()) => self.mark_up(),
            Err(e) => self.mark_down(&e.message),
        }
    }

    fn original(&self, i: &Interaction) -> String {
        let app = if i.app.is_empty() { s(&self.cfg(), "appId").to_owned() } else { i.app.clone() };
        format!("/webhooks/{app}/{}/messages/@original", i.token)
    }

    async fn respond(&self, i: &Interaction, kind: u64, data: Option<Value>) -> Result<Value> {
        let mut b = json!({ "type": kind });
        if let Some(d) = data {
            b["data"] = d;
        }
        self.rest("POST", &format!("/interactions/{}/{}/callback", i.id, i.token), Some(&b)).await
    }

    fn senders(&self) -> Vec<String> {
        self.cfg().get("senders").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    }

    /// The line a `link <code>` gets; a match links them (by their stable id).
    pub(crate) fn try_link(&self, user: &str, code: Option<&str>) -> &'static str {
        let mut c = self.cfg();
        if !code_matches(code, s(&c, "linkCode")) {
            return WRONG_CODE;
        }
        let mut senders: Vec<Value> = c.get("senders").and_then(Value::as_array).cloned().unwrap_or_default();
        if !senders.iter().any(|x| x.as_str() == Some(user)) {
            senders.push(json!(user));
        }
        c["senders"] = Value::Array(senders);
        self.hub.set_cfg(NAME, c);
        LINKED
    }

    /// Autocomplete: only someone linked gets your names back; anyone else an empty list.
    pub(crate) fn choices(&self, ctx: &ChannelCtx, user: &str, option: &str, typed: &str) -> Value {
        if !allowed(Some(user), &self.senders()) {
            return json!([]);
        }
        let pair = |n: &str, v: &str| (n.to_owned(), v.to_owned());
        let pairs: Vec<(String, String)> = match option {
            "crew" => ctx.crew.iter().map(|m| pair(&m.name, &handle_of(&m.name))).collect(),
            "project" => ctx.projects.iter().map(|p| pair(&p.name, &p.name)).collect(),
            "machine" if !self.hub.grid().in_box() => std::iter::once(pair("here", "here")).chain(ctx.machines.iter().filter(|m| m.usable).map(|m| pair(&m.name, &m.name))).collect(),
            "model" => {
                let mut ids: Vec<String> = ctx.agents.iter().filter(|a| a.available).flat_map(|a| a.models.iter().map(|m| m.id.clone())).filter(|m| !m.is_empty()).collect();
                ids.dedup();
                ids.iter().map(|m| pair(m, m)).collect()
            }
            _ => Vec::new(),
        };
        ix::choices(&pairs, typed)
    }

    /// One interaction. `held`: the grid already answered it ("thinking" or "seen"), so nothing here answers it
    /// again: a "thinking" nobody will fill is taken away instead.
    pub(crate) async fn interaction(self: &Arc<Self>, d: &Value, held: bool) -> Result<()> {
        let Some(i) = ix::read(d) else { return Ok(()) };
        let unsaid = async |i: &Interaction| {
            if held && matches!(i.kind, Kind::Command(_)) {
                let _ = self.rest("DELETE", &self.original(i), None).await;
            }
        };
        if i.user.is_empty() || i.bot {
            unsaid(&i).await;
            return Ok(());
        }
        match i.kind.clone() {
            Kind::Autocomplete { option, typed } => {
                let ctx = self.hub.phone().context().await?;
                self.respond(&i, ix::CHOICES, Some(json!({ "choices": self.choices(&ctx, &i.user, &option, &typed) }))).await.map(drop)
            }
            Kind::Button(id) => self.press(&i, &id, held).await,
            Kind::Command(text) => self.slash(&i, text, held).await,
            Kind::Ping | Kind::Other => {
                unsaid(&i).await;
                Ok(())
            }
        }
    }

    /// The door for an interaction: someone linked, once, at their pace. → false when it stops here (`say`: how a
    /// stranger in a DM is told, once).
    async fn door(&self, i: &Interaction, held: bool, tell: bool) -> Result<bool> {
        let senders = self.senders();
        let g = {
            let (mut seen, mut limit) = (lock(&self.seen), lock(&self.limit));
            let at_s = (!held).then(|| snowflake_ms(&i.id).map(|ms| ms / 1000)).flatten();
            let id = format!("ix:{}", i.id);
            gate(GateArgs { sender: Some(&i.user), senders: &senders, id: Some(&id), at_s, seen: Some(&mut seen), limit: Some(&mut limit), now_ms: self.hub.now_ms(), dm: i.dm, stranger_line: if held { STRANGER_BOX } else { STRANGER }, ..GateArgs::default() })
        };
        let Gate::Refused { reply, why } = g else { return Ok(true) };
        self.hub.phone().count("refused", Some(&format!("{why:?}").to_lowercase()));
        let once = i.dm && matches!(lock(&self.strangers).hit(&i.user, self.hub.now_ms()), RateHit::Ok);
        if let Some(r) = reply.filter(|_| once && tell) {
            if held {
                self.rest("PATCH", &self.original(i), Some(&crate::post_body(&r, None))).await?;
            } else {
                self.respond(i, ix::MESSAGE, Some(json!({ "content": discord_text(&r), "flags": EPHEMERAL | SUPPRESS_EMBEDS, "allowed_mentions": { "parse": [] } }))).await?;
            }
        } else if held {
            let _ = self.rest("DELETE", &self.original(i), None).await;
        }
        Ok(false)
    }

    /// `/wisp …`: read as the words it stands for, through the same flow as a mention.
    async fn slash(self: &Arc<Self>, i: &Interaction, text: String, held: bool) -> Result<()> {
        let text = wisp_channels_api::markup::strip_formatting(&text, wisp_channels_api::markup::Markup::Discord, "");
        if i.dm
            && let Some(code) = link_code(&text)
        {
            if !lock(&self.seen).first(&format!("link:{}", i.id)) {
                return Ok(());
            }
            if !held {
                self.respond(i, ix::DEFERRED, Some(json!({ "flags": EPHEMERAL }))).await?;
            }
            let line = self.try_link(&i.user, code);
            self.rest("PATCH", &self.original(i), Some(&crate::post_body(line, None))).await?;
            return Ok(());
        }
        if !self.door(i, held, true).await? {
            return Ok(());
        }
        if !held {
            self.respond(i, ix::DEFERRED, None).await?; // Discord gives this three seconds
        }
        let m = Message { id: i.id.clone(), channel: i.channel.clone(), dm: i.dm, author: i.user.clone(), content: text.clone(), reference: None };
        let phone = self.hub.phone();
        let ctx = phone.context().await?;
        let typed = if text.is_empty() { "help".to_owned() } else if text.to_lowercase().starts_with("new ") || text.eq_ignore_ascii_case("new") { format!("/{text}") } else { text };
        let session = self.session_for(&i.channel, None);
        let mut c = crate::conv::DiscordConv::new(self, phone, ctx, &m, Some(self.original(i)));
        c.slash_thread = i.in_thread;
        let went = self.hub.converse(&c, &typed, session.as_deref(), None).await;
        // a deferred reply shows "thinking" until it's edited: however the work ended, it is
        let hook = lock(&c.hook).take();
        if let Some(path) = hook {
            match &went {
                Err(_) => drop(self.rest("PATCH", &path, Some(&crate::post_body(WENT_WRONG, None))).await),
                Ok(_) => drop(self.rest("DELETE", &path, None).await),
            }
        }
        went.map(drop)
    }

    /// A press: signed by this wisp, by someone linked. The message loses its buttons and the result is said.
    async fn press(&self, i: &Interaction, id: &str, held: bool) -> Result<()> {
        if !self.door(i, held, false).await? {
            return Ok(());
        }
        if !held {
            self.respond(i, ix::UPDATE, None).await?;
        }
        let say = async |t: &str| self.say(&i.channel, None, t).await.map(drop);
        let parsed = ix::parse_custom_id(id);
        let kind = parsed.as_ref().and_then(|(k, ..)| ActionKind::from_code(k)).filter(|k| *k != ActionKind::Done);
        let (Some((k, session, r, index, sig)), Some(kind)) = (parsed, kind) else { return say(DEAD_BUTTON).await };
        if !self.hub.verify(&Signed { s: session.clone(), k, r: r.clone(), i: index, sig }) {
            return say(DEAD_BUTTON).await;
        }
        if kind == ActionKind::Reply && self.hub.phone().session(&session).await.ok().flatten().is_none_or(|sv| sv.mode == Some(Mode::Auto)) {
            return say(IN_WORDS).await;
        }
        let result = match self.hub.act(&ActArgs { session_id: session, kind: kind.into(), reference: Some(r), index: Some(index), text: None, approvals: false }).await {
            Ok(r) => r,
            Err(e) => format!("Couldn’t send that: {}", wisp_channels_api::scrub::truncate(&e.message, 300)),
        };
        let _ = self.rest("PATCH", &self.original(i), Some(&json!({ "components": [] }))).await;
        say(&result).await
    }

    /// A report's choices as signed buttons: answers, and replies unless the task runs in Full auto.
    pub(crate) fn components(&self, msg: &Msg, sv: &SessionView) -> Vec<Value> {
        let b: Vec<(String, String, bool)> = msg
            .actions
            .iter()
            .filter(|a| a.kind == ActionKind::Answer || (a.kind == ActionKind::Reply && sv.mode != Some(Mode::Auto)))
            .map(|a| (discord_text(&a.label), ix::custom_id(a.kind.code(), &sv.id, &a.reference, a.index, &self.hub.sign(&sv.id, a.kind, &a.reference, a.index)), false))
            .collect();
        ix::rows(&b)
    }

    /// An interaction Discord posted to this cloud wisp's URL, held by the grid (v1 `inbound`). Its signature is
    /// checked with the application's own key; a ping and a keystroke are answered here and now; anything older
    /// than its token is dropped (and whoever's linked told); a repeat is dropped by its id; a stranger's gets a
    /// 403 (so the grid stops paying for their wakes); the rest goes on behind the answer.
    pub(crate) async fn held(self: &Arc<Self>, raw: &[u8], headers: &Headers, opts: InboundOpts) -> InboundResult {
        let c = self.cfg();
        if c["enabled"] != true || self.hub.grid().grid().is_none() {
            return InboundResult::error(409, "Discord isn’t on here.");
        }
        if !opts.verified && !ix::signed(s(&c, "publicKey"), header(headers, "x-signature-timestamp").unwrap_or_default(), raw, header(headers, "x-signature-ed25519").unwrap_or_default()) {
            return InboundResult::error(401, "Bad signature.");
        }
        let j: Value = serde_json::from_slice(raw).unwrap_or(Value::Null);
        let Some(i) = ix::read(&j) else { return InboundResult::error(400, "Not an interaction.") };
        match &i.kind {
            Kind::Ping => return InboundResult::new(200, json!({ "type": ix::PONG })),
            Kind::Autocomplete { option, typed } => {
                let ctx = self.hub.phone().context().await.unwrap_or_default();
                return InboundResult::new(200, json!({ "type": ix::CHOICES, "data": { "choices": self.choices(&ctx, &i.user, option, typed) } }));
            }
            _ => {}
        }
        let now = self.hub.now_ms();
        let age = now - snowflake_ms(&i.id).unwrap_or(now);
        let senders = self.senders();
        if age > ix::HELD_MAX_MS {
            self.hub.warn(&format!("discord: dropped a held interaction, {} min old: its token is about to die", age / 60_000));
            if allowed(Some(&i.user), &senders) {
                let _ = self.say(&i.channel, None, &crate::lost_line(1)).await;
            }
            return InboundResult::error(410, "Too old.");
        }
        let ours = allowed(Some(&i.user), &senders) || (i.dm && matches!(&i.kind, Kind::Command(t) if link_code(t).flatten().is_some_and(|code| code_matches(Some(code), s(&c, "linkCode")))));
        let mut cfg = c.clone();
        let mut seen: Vec<Value> = cfg.get(SEEN_KEY).and_then(Value::as_array).cloned().unwrap_or_default();
        if seen.iter().any(|x| x.as_str() == Some(i.id.as_str())) {
            return if ours { InboundResult::new(200, json!({ "ok": true, "duplicate": true })) } else { InboundResult::error(403, "Not from someone linked.") };
        }
        // by age, not count: a stranger's flood can't push an id out, and past this age it's refused anyway
        seen.push(json!(i.id));
        seen.retain(|x| x.as_str().and_then(snowflake_ms).is_some_and(|ms| now - ms <= ix::HELD_MAX_MS));
        cfg[SEEN_KEY] = Value::Array(seen);
        if ours {
            cfg["spoke"] = json!(i.channel);
        }
        self.hub.set_cfg(NAME, cfg);
        let Some(me) = self.this.upgrade() else { return InboundResult::error(503, "Discord is stopping.") };
        let after: wisp_kernel::BoxFuture<'static, ()> = Box::pin(async move {
            if let Err(e) = me.interaction(&j, true).await {
                me.hub.warn(&format!("discord: {}", e.message));
            }
        });
        let r = if ours { InboundResult::ok() } else { InboundResult::error(403, "Not from someone linked.") };
        r.then(after)
    }
}

/// A crew member's `@handle` (v1 `handleOf`, as wisp.channels' grammar reads it): `Ada Lovelace` → `ada-lovelace`.
fn handle_of(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.chars().take(24).collect::<String>().trim_end_matches('-').to_owned()
}
