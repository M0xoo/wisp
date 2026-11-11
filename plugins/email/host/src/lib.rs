//! wisp-email: the email transport for wisp.channels, on a cloud wisp (v1 channels/email.js). A message to your
//! secret address starts a task or follows one up, and the answer comes back as a reply. The grid takes the mail,
//! checks the provider's DKIM/DMARC, and holds it (grid mail); this is the rest of the door. There's no email
//! without a grid: a computer has no address.
//!
//! Who a message is from comes only from the grid's `x-wisp-mail-*` headers, beside the message, never in it: a
//! DMARC `pass` and the one allowed sender, or a 403 and silence (an answer to a forged From would land on the
//! person it was forged from). Only what a person just wrote is read; a reply to a task follows that task and never
//! reads the subject, and a reply to nothing wisp knows starts nothing. Plan unless asked, Edits at most.
//!
//! Attachments: the files the grid brought (1 MB each, 1.4 MB in all) become uploads the task or its turn gets;
//! the ones it couldn't bring are said.

use std::sync::{Arc, Mutex, PoisonError, Weak};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::conversation::Conversation;
use wisp_channels_api::policy::{Gate, GateArgs, RateLimit, gate};
use wisp_channels_api::scrub::{scrub_out, truncate};
use wisp_channels_api::transport::{Headers, InboundOpts, InboundResult, header};
use wisp_channels_api::views::{ActionKind, Msg, SessionView};
use wisp_channels_api::{ChannelCtx, ChannelHub, Mode, Parsed, Phone, Status, TRANSPORTS, Thread, Transport, TransportDef, TransportKind};
use wisp_email_core as ec;
use wisp_kernel::{BoxFuture, CancellationToken, Manifest, Plugin, Result, Setup, WireError};

pub const NAME: &str = "email";

#[derive(Debug, Default)]
pub struct EmailPlugin;

/// The transport on `hub` (tests drive it on the api's test hub).
pub fn transport(hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
    Def.create(hub)
}

struct Def;
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        NAME
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new_cyclic(|this| Email { this: this.clone(), hub, limit: Mutex::default() })
    }
}

struct Email {
    this: Weak<Email>,
    hub: Arc<dyn ChannelHub>,
    limit: Mutex<RateLimit>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// Where a reply goes: the message it answers, its subject, and the task it belongs to.
#[derive(Debug, Clone, Default)]
struct At {
    id: String,
    subject: String,
    session: Option<String>,
}

impl Email {
    fn cfg(&self) -> Value {
        self.hub.cfg(NAME)
    }
    fn mark(&self, error: Option<String>, refused: Option<&str>) {
        let mut st = Status { ok: Some(error.is_none() && refused.is_none()), error, at: Some(self.hub.now_ms()), ..Status::default() };
        if let Some(r) = refused {
            st.more.insert("refused".into(), json!(r));
        }
        self.hub.mark(NAME, st);
    }

    /// True the first time; kept in the config, as a box forgets everything when it sleeps.
    fn first(&self, id: &str) -> bool {
        let mut cfg = self.cfg();
        let mut seen: Vec<Value> = cfg["seen"].as_array().cloned().unwrap_or_default();
        if seen.iter().any(|x| x.as_str() == Some(id)) {
            return false;
        }
        seen.push(json!(id));
        let extra = seen.len().saturating_sub(ec::SEEN_MAX);
        cfg["seen"] = Value::Array(seen.into_iter().skip(extra).collect());
        self.hub.set_cfg(NAME, cfg);
        true
    }

    /// Silence for whoever sent it; Settings says why, so a real sender isn't left guessing.
    fn refused(&self, why: &str, error: &str) -> InboundResult {
        self.mark(None, Some(why));
        self.hub.phone().count("refused", Some(why));
        InboundResult { status: 403, body: json!({ "error": error }), after: None }
    }

    /// Only ever a reply: `at.id` is a message this box accepted, and the grid holds where it came from.
    async fn say(&self, at: &At, text: &str) -> Result<Value> {
        let b = self.hub.grid().grid().ok_or_else(|| WireError::conflict(ec::NOT_ON_A_BOX))?;
        let clean = ec::clip_bytes(&scrub_out(text, true).text, ec::REPLY_MAX);
        let subject = scrub_out(&ec::reply_subject(&at.subject), false).text;
        let sent = self.hub.grid().mail_reply(&b, &at.id, &subject, &format!("{}\n\n{clean}", ec::REPLY_LINE)).await?;
        if let (Some(sid), Some(mid)) = (at.session.as_deref(), sent.as_deref()) {
            self.add_ids(sid, &[mid.to_owned()], None);
        }
        Ok(json!({ "id": sent }))
    }

    /// The task's mail thread grows: its next reply may answer any of these.
    fn add_ids(&self, sid: &str, ids: &[String], newest: Option<(&str, &str)>) {
        let mut r = self.hub.remote_of(sid).unwrap_or_default();
        let mut t = r.get(NAME).cloned().unwrap_or_else(|| json!({ "ids": [] }));
        let mut all: Vec<Value> = t["ids"].as_array().cloned().unwrap_or_default();
        all.extend(ids.iter().map(|i| json!(i)));
        let extra = all.len().saturating_sub(ec::IDS_MAX);
        t["ids"] = Value::Array(all.into_iter().skip(extra).collect());
        if let Some((id, subject)) = newest {
            t["id"] = json!(id);
            if !subject.is_empty() {
                t["subject"] = json!(subject);
            }
        }
        r.insert(NAME.into(), t);
        self.hub.set_remote(sid, r);
    }

    /// The task a message answers: any message it names that's part of one.
    fn thread_of(&self, refs: &[String]) -> Option<String> {
        if refs.is_empty() {
            return None;
        }
        self.hub.find_remote(&|r, _| r.get(NAME).and_then(|t| t["ids"].as_array()).is_some_and(|ids| ids.iter().any(|x| x.as_str().is_some_and(|i| refs.iter().any(|r| r == i))))).into_iter().next()
    }

    async fn run(self: &Arc<Self>, m: &Value, id: String) -> Result<()> {
        let subject = s(m, "subject").to_owned();
        let own = ec::mail_words(m);
        let refs = ec::refs(m);
        let session = self.thread_of(&refs);
        let mut at = At { id: id.clone(), subject: subject.clone(), session: session.clone() };
        let text = if let Some(sid) = &session {
            // the newest message of a task is what its next reply answers
            self.add_ids(sid, std::slice::from_ref(&id), Some((&id, &subject)));
            own
        } else if ec::is_reply(m) {
            self.say(&at, "wisp can’t find the task this answers, so nothing ran. Send a new message to start one.").await?;
            return Ok(());
        } else {
            let subj = if ec::is_forward(&subject) { String::new() } else { subject.trim().to_owned() };
            [subj, own].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
        };
        let text = if text.trim().is_empty() { "help".to_owned() } else { text };
        let phone = self.hub.phone();
        let ctx = phone.context().await?;
        let mut ids = vec![id];
        ids.extend(refs);
        at.session = session.clone();
        // its files, kept as uploads for the task (or the turn) it starts
        let mut files = Vec::new();
        for (name, mime, bytes) in ec::files_of(m) {
            match phone.upload(&name, &mime, bytes).await {
                Ok(u) => files.push(u),
                Err(e) => self.hub.warn(&format!("email: an attachment wasn't kept: {}", e.message)),
            }
        }
        if let Some(line) = ec::left_out(m, files.len()) {
            self.say(&at, &line).await?;
        }
        let conv = MailConv { email: self.clone(), phone, ctx, at: Mutex::new(at), ids, sender: s(&self.cfg(), "sender").to_owned(), files };
        self.hub.converse(&conv, &text, session.as_deref(), None).await.map(drop)
    }
}

struct MailConv {
    email: Arc<Email>,
    phone: Arc<dyn Phone>,
    ctx: ChannelCtx,
    at: Mutex<At>,
    /// this message and what it names: the new task's thread
    ids: Vec<String>,
    sender: String,
    /// its attachments, kept as uploads
    files: Vec<Value>,
}

#[async_trait]
impl Conversation for MailConv {
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
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn name(&self) -> &str {
        "Email"
    }
    fn sender(&self) -> &str {
        &self.sender
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
    fn attachments(&self) -> Vec<Value> {
        self.files.clone()
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn no_thread(&self) -> &str {
        "There’s no task on this one yet."
    }
    async fn say(&self, text: String) -> Result<Value> {
        let at = lock(&self.at).clone();
        self.email.say(&at, &text).await
    }
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        let at = lock(&self.at).clone();
        let mut more = std::collections::BTreeMap::new();
        more.insert("subject".into(), json!(at.subject));
        Some(Thread { channel: NAME.into(), reference: Some(at.id), session: None, more })
    }
    /// the first reply went: the task keeps its mail thread, so a reply to any of it follows it up
    fn acked(&self, thread: Option<&Thread>, sent: &Value) {
        let Some(sid) = thread.and_then(|t| t.session.as_deref()) else { return };
        let at = lock(&self.at).clone();
        let mut ids = self.ids.clone();
        ids.extend(sent.get("id").and_then(Value::as_str).map(str::to_owned));
        let mut r = self.email.hub.remote_of(sid).unwrap_or_default();
        let keep = ids.len().saturating_sub(ec::IDS_MAX);
        r.insert(NAME.into(), json!({ "id": at.id, "subject": at.subject, "ids": ids.into_iter().skip(keep).collect::<Vec<_>>() }));
        self.email.hub.set_remote(sid, r);
        self.email.hub.mark_started(sid, NAME, None);
    }
}

#[async_trait]
impl Transport for Email {
    fn name(&self) -> &str {
        NAME
    }
    fn ready(&self) -> bool {
        let c = self.cfg();
        c["enabled"] == true && !s(&c, "sender").is_empty() && self.hub.grid().grid().is_some()
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }

    /// Asks the grid whether it has mail, and for this user's address. Once per start: nothing to keep up.
    async fn start(&self, _stop: CancellationToken) {
        let Some(b) = self.hub.grid().grid() else { return };
        match self.hub.grid().channel_url(&b, NAME, None, false).await {
            Ok(Some(found)) => {
                let mut cfg = self.cfg();
                if let Some(a) = found.address.filter(|a| cfg["address"].as_str() != Some(a)) {
                    cfg["address"] = json!(a);
                    self.hub.set_cfg(NAME, cfg);
                    self.hub.changed();
                }
            }
            Err(e) if self.ready() => self.mark(Some(format!("Couldn’t reach the grid: {}", e.message)), None),
            Ok(None) | Err(_) => {}
        }
    }

    /// A message the grid held: who it's from only from the grid's headers, a DMARC pass, the one allowed sender,
    /// its date (the earlier of the sender's and the grid's) through the door, then the work after the answer.
    async fn inbound(&self, raw: &[u8], headers: &Headers, opts: InboundOpts) -> InboundResult {
        if !self.ready() {
            return InboundResult { status: 409, body: json!({ "error": "Email isn’t on here." }), after: None };
        }
        let (from, id) = (header(headers, ec::FROM).unwrap_or_default().to_owned(), header(headers, ec::ID).unwrap_or_default().to_owned());
        match header(headers, ec::DMARC) {
            Some("unproved") => return self.refused("dkim", "No signature proves who it’s from."),
            Some("pass") => {}
            _ => return self.refused("dmarc", "No DMARC pass."),
        }
        if from.is_empty() || id.is_empty() {
            return self.refused("dmarc", "Nobody it’s certainly from.");
        }
        let Ok(m) = serde_json::from_slice::<Value>(raw) else { return InboundResult { status: 400, body: json!({ "error": "Not a message." }), after: None } };
        let sender = s(&self.cfg(), "sender").to_lowercase();
        if from.to_lowercase() != sender {
            return self.refused("stranger", "Not the allowed sender.");
        }
        let Some(sent) = ec::date_ms(&m["date"]) else { return self.refused("date", "It has no date.") };
        let at_s = sent.min(if opts.at_ms > 0 { opts.at_ms } else { sent }) / 1000;
        if !self.first(&id) {
            return InboundResult { status: 200, body: json!({ "ok": true, "duplicate": true }), after: None };
        }
        let g = {
            let mut limit = lock(&self.limit);
            gate(GateArgs { sender: Some(&sender), senders: std::slice::from_ref(&sender), at_s: Some(at_s), limit: Some(&mut limit), now_ms: self.hub.now_ms(), ..GateArgs::default() })
        };
        self.mark(None, None);
        let Some(me) = self.this.upgrade() else { return InboundResult { status: 503, body: json!({ "error": "Email is stopping." }), after: None } };
        let at = At { id: id.clone(), subject: s(&m, "subject").to_owned(), session: None };
        let after: BoxFuture<'static, ()> = Box::pin(async move {
            let done = match g {
                Gate::Ok => me.run(&m, id).await,
                Gate::Refused { reply: Some(r), .. } => me.say(&at, &r).await.map(drop),
                Gate::Refused { .. } => Ok(()),
            };
            if let Err(e) = done {
                me.mark(Some(e.message), None);
            }
        });
        InboundResult { status: 200, body: json!({ "ok": true }), after: Some(after) }
    }

    fn reports(&self, s: Option<&SessionView>) -> bool {
        s.and_then(|s| self.hub.started_from(&s.id)).is_some_and(|(c, _)| c == NAME)
    }

    /// Only for a task that came by mail: its report as a reply to its newest message.
    async fn publish(&self, msg: &Msg, sv: Option<&SessionView>) -> Result<()> {
        let Some(sv) = sv else { return Ok(()) };
        let Some(t) = self.hub.remote_of(&sv.id).and_then(|r| r.get(NAME).cloned()) else { return Ok(()) };
        let choices: Vec<&str> = msg.actions.iter().filter(|a| a.kind != ActionKind::Done).map(|a| a.label.as_str()).collect();
        let text = [msg.title.clone(), msg.text.clone(), if choices.is_empty() { String::new() } else { format!("Choices: {}", choices.join(" · ")) }].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
        let at = At { id: s(&t, "id").to_owned(), subject: s(&t, "subject").to_owned(), session: Some(sv.id.clone()) };
        self.say(&at, &text).await?;
        self.hub.phone().count("report", Some("full"));
        Ok(())
    }

    fn view(&self) -> Option<Value> {
        let c = self.cfg();
        Some(json!({ "enabled": c["enabled"] == true, "address": s(&c, "address"), "sender": s(&c, "sender") }))
    }

    /// Settings → Phone → Email: on or off, and the one sender allowed.
    async fn update(&self, body: &Value) -> Result<()> {
        let mut c = self.cfg();
        if let Some(sender) = body.get("sender").and_then(Value::as_str) {
            let sender = sender.trim().to_lowercase();
            if !sender.is_empty() && !ec::is_address(&sender) {
                return Err(WireError::invalid("That doesn’t look like an email address."));
            }
            c["sender"] = json!(sender);
        }
        if let Some(on) = body.get("enabled").and_then(Value::as_bool) {
            if on && self.hub.grid().grid().is_none() {
                return Err(WireError::invalid(ec::NOT_ON_A_BOX));
            }
            c["enabled"] = json!(on);
        }
        self.hub.set_cfg(NAME, c);
        Ok(())
    }

    async fn rotate(&self) -> InboundResult {
        let Some(b) = self.hub.grid().grid() else { return InboundResult { status: 409, body: json!({ "error": "This cloud computer has no address." }), after: None } };
        match self.hub.grid().rotate_url(&b, NAME).await {
            Ok(u) => {
                let mut c = self.cfg();
                c["address"] = json!(u.address);
                self.hub.set_cfg(NAME, c);
                InboundResult { status: 200, body: json!({ "ok": true, "address": u.address }), after: None }
            }
            Err(e) => InboundResult { status: 502, body: json!({ "error": truncate(&e.message, 300) }), after: None },
        }
    }
}

impl Plugin for EmailPlugin {
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
        assert_eq!(EmailPlugin.manifest().id, "wisp.email");
    }
}
