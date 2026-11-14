//! The grid's side of mail (v1 grid/mail.js `createMail`). Two things sit here because a box can't be trusted with
//! them:
//! - Who a message is from. The provider's webhook is checked at this edge, and only this writes the
//!   `x-wisp-mail-*` headers a box goes by, beside the message and never in it. `pass` means proved: SES didn't fail
//!   DMARC, and a DKIM signature this grid verified itself has `d=` equal to the From's domain. Whatever can't be
//!   proved is refused.
//! - Who a box can write to. Sending takes no address: only a held thread, which exists once its box accepted a
//!   proved message (a 2xx), at a rate, to the address that message came from. A stranger's refused mail holds
//!   nothing, so no one can make themselves a target by writing in.

use base64::Engine as _;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::{OptionalExtension as _, params};
use serde_json::{Value, json};

use super::mime::{self, Mail};
use super::ses::{self, Inbound};
use crate::clock::SharedClock;
use crate::db::Db;
use crate::dkim::{self, Lookup, Txt};
use crate::error::{Result, bad};
use crate::inbox::Inbox;
use crate::rows::UserRow;
use crate::secrets::{sha256, token};

pub const FROM_HEADER: &str = "x-wisp-mail-from";
pub const DMARC_HEADER: &str = "x-wisp-mail-dmarc";
pub const ID_HEADER: &str = "x-wisp-mail-id";
pub const WEBHOOK_MAX: usize = 512 * 1024;
/// bytes: the box stops at 30 000 of them, and adds a line
const REPLY_MAX: usize = 40 * 1024;
const SUBJECT_MAX: usize = 200;
const THREADS_MAX: i64 = 100;
const CERTS_MAX: usize = 8;
const HOUR_MS: i64 = 3_600_000;

/// What sending needs (grid.json `mail.outbound`, its secret resolved).
#[derive(Debug, Clone, Default)]
pub struct Outbound {
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub endpoint: Option<String>,
}

/// Mail's settings in force.
#[derive(Debug, Clone, Default)]
pub struct Opts {
    pub domain: String,
    pub topic_arn: String,
    /// pinned public keys (PEM): no fetch of AWS's certificate
    pub keys: Vec<String>,
    pub outbound: Outbound,
    pub send_per_hour: i64,
    pub thread_days: i64,
}

/// How a message leaves (SES, or a test's stand-in).
#[async_trait::async_trait]
pub trait Wire: Send + Sync {
    async fn send(&self, from: &str, to: &str, raw: &str) -> std::result::Result<(), String>;
    async fn fetch(&self, url: &str) -> std::result::Result<String, String>;
}

/// SES over reqwest (no redirects: a key or a confirmation URL is SNS's own or nothing).
pub struct Http {
    pub client: reqwest::Client,
    pub out: Outbound,
    pub clock: SharedClock,
}

impl std::fmt::Debug for Http {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Http").field("region", &self.out.region).finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl Wire for Http {
    async fn send(&self, from: &str, to: &str, raw: &str) -> std::result::Result<(), String> {
        let stamp = stamp(self.clock.now_ms());
        let creds = ses::Creds {
            region: &self.out.region,
            key_id: &self.out.access_key_id,
            secret: &self.out.secret_access_key,
            endpoint: self.out.endpoint.as_deref(),
        };
        let (url, body, headers) = ses::send_request(creds, from, to, raw, &stamp);
        let mut req = self.client.post(url).body(body).timeout(std::time::Duration::from_secs(15));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let r = req.send().await.map_err(|e| e.to_string())?;
        if r.status().is_success() { Ok(()) } else { Err(format!("SES said {}", r.status().as_u16())) }
    }
    async fn fetch(&self, url: &str) -> std::result::Result<String, String> {
        let r = self.client.get(url).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("it said {}", r.status().as_u16()));
        }
        r.text().await.map_err(|e| e.to_string())
    }
}

/// `YYYYMMDDTHHMMSSZ` for `SigV4`.
pub fn stamp(ms: i64) -> String {
    let iso = crate::mail::iso_of(ms);
    format!("{}Z", iso.replace(['-', ':'], "").split('.').next().unwrap_or_default())
}

/// The system's resolver for DKIM keys (ADR-0045).
pub fn system_txt() -> Option<Arc<Txt>> {
    let resolver = hickory_resolver::TokioResolver::builder_tokio().ok()?.build().ok()?;
    let r = Arc::new(resolver);
    Some(Arc::new(move |name: String| {
        let r = r.clone();
        Box::pin(async move {
            let looked = tokio::time::timeout(std::time::Duration::from_secs(5), r.txt_lookup(name)).await.map_err(|_| Lookup::Failed)?;
            match looked {
                Ok(l) => Ok(l
                    .answers()
                    .iter()
                    .filter_map(|rec| match &rec.data {
                        hickory_resolver::proto::rr::RData::TXT(t) => Some(t.txt_data.iter().map(|b| dkim::latin1(b)).collect()),
                        _ => None,
                    })
                    .collect()),
                Err(e) if e.is_no_records_found() || e.is_nx_domain() => Err(Lookup::NoSuchKey),
                Err(_) => Err(Lookup::Failed),
            }
        })
    }))
}

pub struct MailService {
    pub db: Arc<Db>,
    pub clock: SharedClock,
    pub opts: Opts,
    pub txt: Arc<Txt>,
    pub out: Arc<dyn Wire>,
    certs: Mutex<VecDeque<(String, rsa::RsaPublicKey)>>,
}

/// The answer to the provider: a bad signature is a 403, a 503 asks for the message again while DNS isn't
/// answering, anything else signed gets its 200 so the provider stops.
pub type Answer = (u16, Value);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether the provider's own reading of From, if it gave one, is the one address we read.
fn same_sender(named: Option<&Vec<String>>, from: &str) -> bool {
    named.is_none_or(|n| n.len() == 1 && mime::mailbox(&n[0]) == from)
}

impl std::fmt::Debug for MailService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailService").field("domain", &self.opts.domain).finish_non_exhaustive()
    }
}

impl MailService {
    pub fn new(db: Arc<Db>, clock: SharedClock, opts: Opts, txt: Arc<Txt>, out: Arc<dyn Wire>) -> Self {
        Self { db, clock, opts, txt, out, certs: Mutex::default() }
    }

    /// The keys a notification may be signed with: the pinned ones, else AWS's certificate at that URL.
    async fn keys_for(&self, url: &str) -> Vec<rsa::RsaPublicKey> {
        if !self.opts.keys.is_empty() {
            return self.opts.keys.iter().filter_map(|k| ses::key_of(k)).collect();
        }
        if let Some((_, k)) = lock(&self.certs).iter().find(|(u, _)| u == url) {
            return vec![k.clone()];
        }
        let Some(k) = self.out.fetch(url).await.ok().and_then(|pem| ses::key_of(&pem)) else { return Vec::new() };
        let mut c = lock(&self.certs);
        c.push_back((url.to_owned(), k.clone()));
        if c.len() > CERTS_MAX {
            c.pop_front();
        }
        vec![k]
    }

    /// The user an address belongs to: its local part is the user's sealed token for the email channel.
    fn user_of(&self, rcpt: &str) -> Result<Option<UserRow>> {
        let Some((local, domain)) = rcpt.rsplit_once('@') else { return Ok(None) };
        if !domain.eq_ignore_ascii_case(&self.opts.domain) {
            return Ok(None);
        }
        let id: Option<String> = self.db.with(|c| {
            c.query_row(
                "SELECT user_id FROM channel_urls WHERE token_hash = ?1 AND channel = 'email'",
                [sha256(local.to_lowercase())],
                |r| r.get(0),
            )
            .optional()
        })?;
        let Some(id) = id else { return Ok(None) };
        crate::accounts::Accounts { db: self.db.clone(), clock: self.clock.clone() }.user_by_id(&id)
    }

    /// This user's address (made the first time; asking again gives the same one).
    pub fn address_of(&self, inbox: &Inbox, user: &UserRow) -> Result<String> {
        let secrets = inbox.secrets.as_ref().ok_or_else(|| bad("This grid has no master key, so no mail.", 409))?;
        let sealed = secrets.ensure(&user.id, "channel:email")?.to_lowercase();
        let now = self.clock.now_ms();
        self.db.with(|c| c.execute("INSERT INTO channel_urls (user_id, channel, token_hash, created_at) VALUES (?1, 'email', ?2, ?3) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash", params![user.id, sha256(&sealed), now]))?;
        Ok(format!("{sealed}@{}", self.opts.domain))
    }

    /// A new address for a leaked one.
    pub fn rotate(&self, inbox: &Inbox, user: &UserRow) -> Result<String> {
        let secrets = inbox.secrets.as_ref().ok_or_else(|| bad("This grid has no master key, so no mail.", 409))?;
        let fresh = token("", 24).to_lowercase();
        secrets.seal(&user.id, "channel:email", &fresh)?;
        self.db.with(|c| {
            c.execute("UPDATE channel_urls SET token_hash = ?1 WHERE user_id = ?2 AND channel = 'email'", params![sha256(&fresh), user.id])
        })?;
        Ok(format!("{fresh}@{}", self.opts.domain))
    }

    /// What can't be answered, or that nobody would want woken for, stops here.
    fn wanted(&self, m: &Mail, source: &str) -> bool {
        !m.auto && !source.is_empty() && source != "<>" && !m.from.ends_with(&format!("@{}", self.opts.domain))
    }

    /// 'pass', or why not; None: DNS didn't answer for the From's own domain (SNS can bring it back). d= has to be
    /// the From's domain exactly (relaxed alignment needs the public suffix list).
    async fn proved(&self, verdict: &str, exact: bool, named: Option<&Vec<String>>, content: &[u8], m: &Mail) -> Option<String> {
        if verdict != "unproved" || !exact || m.from.is_empty() || !same_sender(named, &m.from) {
            return Some(verdict.to_owned());
        }
        let domain = m.from.rsplit_once('@').map(|(_, d)| d).unwrap_or_default();
        let checked = dkim::verify(content, self.txt.as_ref(), self.clock.now_ms() / 1000).await;
        let own: Vec<&dkim::Checked> = checked.iter().filter(|c| c.d == domain).collect();
        if own.iter().any(|c| c.ok) {
            return Some("pass".into());
        }
        if own.iter().any(|c| c.dns) { None } else { Some("unproved".into()) }
    }

    /// The provider's webhook (SES over SNS).
    pub async fn webhook(&self, inbox: &Inbox, raw: &[u8]) -> Result<(Answer, Vec<UserRow>)> {
        let mut held = Vec::new();
        let a = self.webhook_in(inbox, raw, &mut held).await?;
        Ok((a, held))
    }

    async fn webhook_in(&self, inbox: &Inbox, raw: &[u8], held: &mut Vec<UserRow>) -> Result<Answer> {
        let Ok(j) = serde_json::from_slice::<Value>(raw) else { return Ok((403, json!({ "error": "Not signed." }))) };
        let Some((cert, text, sig)) = ses::signed_text(&j, &self.opts.topic_arn, self.clock.now_ms()) else {
            return Ok((403, json!({ "error": "Not signed." })));
        };
        if !self.keys_for(&cert).await.iter().any(|k| ses::verify(k, &text, &sig)) {
            return Ok((403, json!({ "error": "Not signed." })));
        }
        let region = self.opts.topic_arn.split(':').nth(3).unwrap_or_default();
        match ses::read(&j, region) {
            None => Ok((403, json!({ "error": "Not signed." }))),
            Some(Inbound::Confirm(url)) => {
                if let Err(e) = self.out.fetch(&url).await {
                    tracing::warn!("grid: mail: couldn’t confirm the subscription: {e}");
                }
                Ok((200, json!({ "ok": true })))
            }
            Some(Inbound::Mail { recipients, verdict, source, content, exact, named }) => {
                let m = mime::parse_mail(&content);
                let mut users: Vec<UserRow> = Vec::new();
                for r in &recipients {
                    if let Some(u) = self.user_of(r)?.filter(|u| u.disabled == 0 && !users.iter().any(|x| x.id == u.id)) {
                        users.push(u);
                    }
                }
                // last, so neither a stranger's guess at an address nor a forged webhook costs a DNS lookup
                if !users.is_empty() && self.wanted(&m, &source) {
                    let Some(v) = self.proved(&verdict, exact, named.as_ref(), &content, &m).await else {
                        return Ok((503, json!({ "error": "Try again." })));
                    };
                    for u in users {
                        if Self::take(inbox, &u, &m, &v)? {
                            held.push(u);
                        }
                    }
                }
                Ok((200, json!({ "ok": true })))
            }
        }
    }

    /// One recipient's copy, held for its box with the grid's own headers.
    fn take(inbox: &Inbox, user: &UserRow, m: &Mail, verdict: &str) -> Result<bool> {
        let Some(def) = crate::inbox::channel("email") else { return Ok(false) };
        let headers = vec![
            (FROM_HEADER.to_owned(), m.from.clone()),
            (DMARC_HEADER.to_owned(), verdict.to_owned()),
            (ID_HEADER.to_owned(), m.message_id.clone()),
        ];
        let body = json!({ "messageId": m.message_id, "subject": m.subject, "text": m.text, "html": m.html, "date": crate::mail::date_iso(&m.date), "inReplyTo": m.in_reply_to, "references": m.references, "attachments": m.attachments, "files": m.files.iter().map(|f| json!({ "name": f.name, "mime": f.mime, "data": base64::engine::general_purpose::STANDARD.encode(&f.bytes) })).collect::<Vec<_>>() });
        let bytes = body.to_string().into_bytes();
        if inbox.hold(user, def, &bytes, &headers, true, &body)? {
            return Ok(true);
        }
        // its files don't fit what's held now: the words still go (the box says the files were left out)
        if m.files.is_empty() {
            return Ok(false);
        }
        let mut bare = body;
        bare["files"] = json!([]);
        let bytes = bare.to_string().into_bytes();
        inbox.hold(user, def, &bytes, &headers, true, &bare)
    }

    /// A message its box accepted: from here on the box may answer it (the inbox calls this on a 2xx).
    pub fn delivered(&self, user_id: &str, headers: &[(String, String)], body: &[u8]) -> Result<()> {
        let h = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or_default();
        if h(DMARC_HEADER) != "pass" || h(FROM_HEADER).is_empty() || h(ID_HEADER).is_empty() {
            return Ok(());
        }
        let refs = serde_json::from_slice::<Value>(body)
            .ok()
            .map(|b| b["references"].clone())
            .filter(Value::is_array)
            .unwrap_or_else(|| json!([]));
        let now = self.clock.now_ms();
        let live = now - self.opts.thread_days * 24 * HOUR_MS;
        self.db.with(|c| {
            c.execute("INSERT INTO mail_threads (user_id, message_id, to_addr, refs, at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id, message_id) DO UPDATE SET at = excluded.at", params![user_id, h(ID_HEADER), h(FROM_HEADER), refs.to_string(), now])?;
            c.execute("DELETE FROM mail_threads WHERE user_id = ?1 AND (at < ?2 OR message_id NOT IN (SELECT message_id FROM mail_threads WHERE user_id = ?1 ORDER BY at DESC LIMIT ?3))", params![user_id, live, THREADS_MAX])
        })?;
        Ok(())
    }

    /// A box answering a message it accepted. It says which message, never who to: the address comes from the
    /// thread, and a body that tries to name one is refused rather than ignored.
    pub async fn reply(&self, inbox: &Inbox, user: &UserRow, body: &Value) -> Result<Value> {
        if ["to", "cc", "bcc", "from", "replyToAddress"].iter().any(|k| body.get(*k).is_some()) {
            return Err(bad("A reply goes to the sender of its thread, and nowhere else.", 400));
        }
        let now = self.clock.now_ms();
        let live = now - self.opts.thread_days * 24 * HOUR_MS;
        let reply_to = body["replyTo"].as_str().unwrap_or_default();
        let t: Option<(String, String, String)> = self.db.with(|c| {
            c.query_row(
                "SELECT message_id, to_addr, refs FROM mail_threads WHERE user_id = ?1 AND message_id = ?2 AND at >= ?3",
                params![user.id, reply_to, live],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
        })?;
        let Some((message_id, to, refs)) = t else { return Err(bad("No such thread.", 404)) };
        let text = body["text"].as_str().filter(|t| !t.trim().is_empty()).ok_or_else(|| bad("Nothing to send.", 400))?;
        if text.len() > REPLY_MAX {
            return Err(bad("That’s too long for a reply.", 413));
        }
        let sent: i64 = self.db.with(|c| {
            c.execute("DELETE FROM mail_sent WHERE user_id = ?1 AND at < ?2", params![user.id, now - HOUR_MS])?;
            c.query_row("SELECT count(*) FROM mail_sent WHERE user_id = ?1", [&user.id], |r| r.get(0))
        })?;
        if sent >= self.opts.send_per_hour {
            return Err(bad("Too many replies this hour.", 429));
        }
        self.db.with(|c| c.execute("INSERT INTO mail_sent (user_id, at) VALUES (?1, ?2)", params![user.id, now]))?;
        let from = self.address_of(inbox, user)?;
        let id = format!("<{}@{}>", token("", 32).to_lowercase(), self.opts.domain);
        // here as well as on the box: an agent with the Box secret doesn't go through the box's code
        let clean = wisp_channels_api::scrub::scrub_out(text, true).text;
        let subject: String = body["subject"].as_str().unwrap_or("Re: your message").chars().take(SUBJECT_MAX).collect();
        let subject = wisp_channels_api::scrub::scrub_out(&subject, false).text;
        let mut references: Vec<String> = serde_json::from_str(&refs).unwrap_or_default();
        references.push(message_id.clone());
        let keep = references.len().saturating_sub(mime::REFS_MAX);
        let references = references.split_off(keep);
        let date = crate::mail::rfc5322(now);
        let raw = mime::compose_mail(&mime::Out {
            from: &format!("wisp <{from}>"),
            to: &to,
            subject: &subject,
            text: &clean,
            message_id: &id,
            in_reply_to: &message_id,
            references: &references,
            date: &date,
        })
        .ok_or_else(|| bad("A line break in a header.", 400))?;
        if let Err(e) = self.out.send(&from, &to, &raw).await {
            tracing::warn!("grid: mail: a reply didn’t go: {e}");
            return Err(bad("The mail provider didn’t take it.", 502));
        }
        Ok(json!({ "messageId": id }))
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
