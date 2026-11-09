//! wisp-telegram: the Telegram transport for wisp.channels (v1 `channels/telegram.js`, its classic path): a bot
//! message with signed buttons; reply to it to answer in your own words or follow up. Linked to one chat with a
//! one-time code (`linkCode`, shown in wisp's settings). With `allowStart`, `/new [@project] <task>` starts a task
//! and `/projects` lists where one can run. It long-polls `getUpdates`; the offset outlives restarts, so a
//! `/new` never starts twice. Every request goes through the hub's `Net`; the wire's decisions are
//! `wisp-telegram-core`'s.
//!
//! Not here yet: the `options` grammar (plain text as the launcher; it needs the channels grammar and lists, still
//! being ported), and the cloud box's webhook through the grid's inbox.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::views::{ActArgs, ActKind, Msg, SessionView, Signed};
use wisp_channels_api::{ChannelHub, HttpRequest, Status, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_channels_api::policy::{Gate, GateArgs, RateLimit, STALE_S, gate};
use wisp_channels_api::scrub::scrub_out;
use wisp_kernel::{CancellationToken, Manifest, Plugin, Result, Setup, WireError};
use wisp_telegram_core::{self as core, Message, Update, encode_tap, forwarded, links_it, parse_tap, publish_text, truncate};

const MAX_TG_IDS: usize = 20;
const LONG_POLL_S: u64 = 25;

#[derive(Debug, Default)]
pub struct TelegramPlugin;

struct Def;
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        "telegram"
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new(Telegram { hub, limit: Mutex::new(RateLimit::default()) })
    }
    fn secrets(&self) -> &'static [&'static str] {
        &["token"]
    }
}

struct Telegram {
    hub: Arc<dyn ChannelHub>,
    limit: Mutex<RateLimit>,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// A chat id as Telegram sends it (a number) or wisp keeps it (a string).
fn id_text(v: &Value) -> String {
    v.as_str().map_or_else(|| v.as_i64().map(|n| n.to_string()).unwrap_or_default(), str::to_owned)
}

impl Telegram {
    fn cfg(&self) -> Value {
        self.hub.cfg("telegram")
    }
    fn chat(&self) -> String {
        id_text(&self.cfg()["chatId"])
    }
    fn mark(&self, error: Option<String>) {
        self.hub.mark("telegram", Status { ok: Some(error.is_none()), error, at: Some(self.hub.now_ms()), ..Status::default() });
    }

    async fn api(&self, method: &str, body: Value, timeout_ms: u64) -> Result<Value> {
        let cfg = self.cfg();
        let base = std::env::var("WISP_TELEGRAM_API").unwrap_or_else(|_| "https://api.telegram.org".into());
        let url = format!("{}/bot{}/{method}", base.trim_end_matches('/'), s(&cfg, "token"));
        let r = self.hub.net().fetch(HttpRequest::post_json(url, &body).timeout(timeout_ms)).await.map_err(|e| WireError::unavailable(format!("Telegram: {e}")))?;
        let j = r.json();
        if j.get("ok") != Some(&Value::Bool(true)) {
            return Err(WireError::unavailable(format!("Telegram: {}", j.get("description").and_then(Value::as_str).map_or_else(|| r.status.to_string(), str::to_owned))));
        }
        Ok(j.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn say(&self, text: &str, reply_to: Option<i64>) -> Result<Value> {
        let mut body = json!({ "chat_id": self.chat(), "text": truncate(&scrub_out(text, true).text, core::CHUNK_MAX) });
        if let Some(m) = reply_to {
            body["reply_to_message_id"] = json!(m);
            body["allow_sending_without_reply"] = json!(true);
        }
        self.api("sendMessage", body, 15_000).await
    }

    /// Replies to this Telegram message reach the task it's about.
    fn link(&self, session: &str, message_id: i64) {
        let mut r = self.hub.remote_of(session).unwrap_or_default();
        let mut ids: Vec<Value> = r.get("tg").and_then(Value::as_array).cloned().unwrap_or_default();
        ids.push(json!(message_id));
        let skip = ids.len().saturating_sub(MAX_TG_IDS);
        r.insert("tg".into(), Value::Array(ids.into_iter().skip(skip).collect()));
        self.hub.set_remote(session, r);
    }

    fn session_of(&self, message_id: i64) -> Option<String> {
        self.hub.find_remote(&move |r, _| r.get("tg").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(message_id)))).into_iter().next()
    }

    async fn on_update(&self, u: Update) {
        if let Some(q) = u.callback_query {
            return self.on_tap(q).await;
        }
        let Some(m) = u.message else { return };
        if let Err(e) = self.on_message(&m).await {
            self.hub.warn(&format!("telegram: {}", e.message));
        }
    }

    /// A button: signed by this wisp, on a message in the linked chat.
    async fn on_tap(&self, q: core::CallbackQuery) {
        let chat = self.chat();
        if chat.is_empty() || q.chat_id() != Some(chat.as_str()) {
            return;
        }
        let tap = q.data.as_deref().and_then(parse_tap);
        let session = tap.as_ref().and_then(|t| t.session.clone()).or_else(|| q.message_id().and_then(|m| self.session_of(m)));
        let result = match (tap, session) {
            (Some(t), Some(session)) => {
                let signed = Signed { s: session.clone(), k: t.kind.code().into(), r: t.reference.clone().unwrap_or_default(), i: t.index, sig: t.sig.clone() };
                if self.hub.verify(&signed) {
                    let a = ActArgs { session_id: session, kind: t.kind.into(), reference: t.reference, index: Some(t.index), text: None, approvals: false };
                    self.hub.act(&a).await.unwrap_or_else(|e| e.message)
                } else {
                    "That button is out of date.".to_owned()
                }
            }
            _ => "Unknown button.".to_owned(),
        };
        let _ = self.api("answerCallbackQuery", json!({ "callback_query_id": q.id, "text": truncate(&scrub_out(&result, false).text, core::text::TAP_ANSWER_MAX) }), 15_000).await;
        if let Some(mid) = q.message_id() {
            let _ = self.api("editMessageReplyMarkup", json!({ "chat_id": chat, "message_id": mid, "reply_markup": { "inline_keyboard": [] } }), 15_000).await;
        }
    }

    async fn on_message(&self, m: &Message) -> Result<()> {
        let Some(text) = m.text.as_deref() else { return Ok(()) };
        let cfg = self.cfg();
        let chat = self.chat();
        if chat.is_empty() {
            // linking: only the chat that sends the code shown in wisp's settings gets attached
            let code = s(&cfg, "linkCode");
            if !code.is_empty() && links_it(text).is_some_and(|c| wisp_telegram_core::secret_ok(Some(c), code)) {
                self.hub.set_cfg("telegram", json!({ "chatId": m.chat.id, "chatName": core::chat_name(&m.chat), "linkCode": "" }));
                self.mark(None);
                self.say("✓ Linked to wisp. Questions and finished tasks will show up here.", None).await?;
            }
            return Ok(());
        }
        if m.chat.id != chat {
            return Ok(());
        }
        let (senders, key) = (vec![chat.clone()], m.rate_key());
        let g = {
            let mut limit = self.limit.lock().unwrap_or_else(PoisonError::into_inner);
            gate(GateArgs { sender: Some(&m.chat.id), senders: &senders, limit: Some(&mut limit), rate_key: Some(&key), now_ms: self.hub.now_ms(), ..GateArgs::default() })
        };
        if let Gate::Refused { reply, .. } = g {
            if let Some(r) = reply {
                self.say(&r, Some(m.message_id)).await?;
            }
            return Ok(());
        }
        if forwarded(m) {
            self.say("Forwarded, so nothing started. Say it in your own words to run it.", Some(m.message_id)).await?;
            return Ok(());
        }
        if let Some((cmd, arg)) = core::slash_command(text)
            && ["new", "projects", "help", "start"].contains(&cmd.as_str())
        {
            return self.command(&cmd, arg.trim(), m, &cfg).await;
        }
        let Some(session) = m.reply_to().and_then(|r| self.session_of(r)) else {
            let line = if cfg["allowStart"] == true { "Reply to one of wisp’s messages to answer it or follow up, or send /new <task> to start one." } else { "Reply to one of wisp’s messages to answer it or send a follow-up." };
            self.say(line, None).await?;
            return Ok(());
        };
        let said = self.hub.act(&ActArgs { session_id: session, kind: ActKind::Text, reference: None, index: None, text: Some(text.to_owned()), approvals: false }).await.unwrap_or_else(|e| e.message);
        self.say(&said, Some(m.message_id)).await?;
        Ok(())
    }

    async fn command(&self, name: &str, arg: &str, m: &Message, cfg: &Value) -> Result<()> {
        let off = "Starting tasks from Telegram is off. Turn it on in wisp → Phone → Telegram.";
        let allow = cfg["allowStart"] == true;
        if name == "help" || name == "start" {
            let line = if allow { "Send /new <task> to start a task in your default project, or /new @project <task> to pick one (/projects lists them). Reply to wisp’s messages to answer or follow up.".to_owned() } else { format!("Reply to wisp’s messages to answer or follow up. {off}") };
            self.say(&line, None).await?;
            return Ok(());
        }
        if !allow {
            self.say(off, None).await?;
            return Ok(());
        }
        // Telegram keeps updates for a day: what was sent while wisp was off doesn't start
        if name == "new" && m.date.is_some_and(|d| self.hub.now_ms() / 1000 - d > STALE_S) {
            self.say("That /new arrived while wisp was offline, so it didn’t start. Send it again to run it now.", Some(m.message_id)).await?;
            return Ok(());
        }
        let phone = self.hub.phone();
        let projects = phone.projects().await.unwrap_or_default();
        if name == "projects" {
            if projects.is_empty() {
                self.say("No projects yet. Open a folder in wisp first.", None).await?;
                return Ok(());
            }
            let def = self.hub.default_project().await.map(|p| p.id);
            let lines: Vec<String> = projects.iter().map(|p| format!("• {}{}{}", p.name, p.machine.as_ref().map(|x| format!(" (on {x})")).unwrap_or_default(), if def.as_deref() == Some(p.id.as_str()) { "  ← default" } else { "" })).collect();
            self.say(&format!("Projects:\n{}\n\n/new @name <task> runs in one of them.", lines.join("\n")), None).await?;
            return Ok(());
        }
        let (mut project, mut prompt) = (self.hub.default_project().await, arg.to_owned());
        if let Some(rest) = arg.strip_prefix('@') {
            let (want, task) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            let found = projects.iter().find(|p| p.name.eq_ignore_ascii_case(want) || p.id == want).cloned();
            let Some(p) = found else {
                self.say(&format!("No project matches “{}”. Send /projects to see them.", truncate(want, 60)), None).await?;
                return Ok(());
            };
            (project, prompt) = (Some(p), task.trim().to_owned());
        }
        if prompt.is_empty() {
            self.say("What should it do? Send /new <task>, or /new @project <task>.", None).await?;
            return Ok(());
        }
        let Some(project) = project else {
            self.say("No projects yet. Open a folder in wisp first.", None).await?;
            return Ok(());
        };
        match phone.launch(&project, &prompt).await {
            Err(e) => {
                self.say(&format!("Couldn’t start it: {}", truncate(&e.message, 300)), Some(m.message_id)).await?;
            }
            Ok(task) => {
                let title = task.as_ref().map_or(prompt.as_str(), |t| t.title.as_str()).to_owned();
                let sent = self.say(&format!("▶ Started in {}: {title}\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.", project.name), Some(m.message_id)).await?;
                if let (Some(t), Some(mid)) = (task, sent.get("message_id").and_then(Value::as_i64)) {
                    self.hub.mark_started(&t.id, "telegram", None);
                    self.link(&t.id, mid);
                }
            }
        }
        Ok(())
    }
}

#[async_trait]
impl Transport for Telegram {
    fn name(&self) -> &'static str {
        "telegram"
    }
    fn ready(&self) -> bool {
        let c = self.cfg();
        c["enabled"] == true && !s(&c, "token").is_empty()
    }
    fn sending(&self) -> bool {
        self.ready() && !self.chat().is_empty()
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Phone
    }
    fn layer(&self) -> bool {
        true
    }
    async fn start(&self, stop: CancellationToken) {
        let long = self.hub.tune("tgLongPoll").unwrap_or(LONG_POLL_S);
        while !stop.is_cancelled() && self.ready() {
            let offset = self.cfg()["offset"].as_i64().unwrap_or(0);
            let got = tokio::select! {
                () = stop.cancelled() => return,
                r = self.api("getUpdates", json!({ "offset": offset, "timeout": long, "allowed_updates": core::UPDATES }), (long + 10) * 1000) => r,
            };
            match got {
                Ok(updates) => {
                    self.mark(None);
                    for raw in updates.as_array().into_iter().flatten() {
                        let Some(u) = serde_json::to_vec(raw).ok().and_then(|b| Update::parse(&b)) else { continue };
                        if u.update_id < offset {
                            continue;
                        }
                        // the offset first: a crash while handling never hands the same /new back
                        self.hub.set_cfg("telegram", json!({ "offset": u.update_id + 1 }));
                        self.on_update(u).await;
                    }
                }
                Err(e) => {
                    self.mark(Some(e.message));
                    tokio::select! {
                        () = stop.cancelled() => return,
                        () = self.hub.sleep(5000) => {}
                    }
                }
            }
        }
    }
    async fn publish(&self, msg: &Msg, sv: Option<&SessionView>) -> Result<()> {
        if !self.sending() {
            return Err(WireError::unavailable("Telegram isn't linked to a chat"));
        }
        let parts = publish_text(msg, sv.is_some());
        let buttons: Vec<Value> = sv.map_or_else(Vec::new, |sv| msg.actions.iter().map(|a| json!([{ "text": truncate(&a.label, core::text::LABEL_MAX), "callback_data": encode_tap(a.kind, a.index, &self.hub.sign(&sv.id, a.kind, &a.reference, a.index), &sv.id, &a.reference) }])).collect());
        let n = parts.len();
        for (i, text) in parts.into_iter().enumerate() {
            let mut body = json!({ "chat_id": self.chat(), "text": text });
            if i + 1 == n && !buttons.is_empty() {
                body["reply_markup"] = json!({ "inline_keyboard": buttons });
            }
            let sent = self.api("sendMessage", body, 15_000).await?;
            if let (Some(sv), Some(mid)) = (sv, sent.get("message_id").and_then(Value::as_i64)) {
                self.link(&sv.id, mid);
            }
        }
        Ok(())
    }
    async fn dropped(&self, n: u32) {
        if self.sending() {
            let _ = self.say(&core::lost_line(n), None).await;
        }
    }
    fn view(&self) -> Option<Value> {
        let c = self.cfg();
        Some(json!({ "enabled": c["enabled"] == true, "token": core::mask(s(&c, "token")), "linked": !self.chat().is_empty(), "chatName": s(&c, "chatName"), "allowStart": c["allowStart"] == true }))
    }
}

impl Plugin for TelegramPlugin {
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
        assert_eq!(TelegramPlugin.manifest().id, "wisp.telegram");
    }

    #[test]
    fn a_chat_id_reads_as_text_either_way() {
        assert_eq!((id_text(&json!(-1_001_234)), id_text(&json!("42")), id_text(&Value::Null)), ("-1001234".to_owned(), "42".to_owned(), String::new()));
    }
}
