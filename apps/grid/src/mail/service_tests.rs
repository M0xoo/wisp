//! v1 test/mail.test.js's grid cases, on the module: SES's signed notification held for the box with the grid's
//! own verdict (pass only for a DKIM signature by the From's own domain), the thread kept once the box took it, and
//! a reply that goes only to that thread's sender, at a rate.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use rsa::pkcs8::EncodePublicKey as _;
use rsa::signature::{SignatureEncoding as _, Signer as _};
use sha2::Sha256;

use super::*;
use crate::boxhost::{BoxState, Busy, Running};
use crate::clock::ManualClock;
use crate::inbox::{Boxes, Deliver, Delivery, Opts as InboxOpts};
use crate::rows::BoxUser;

const ARN: &str = "arn:aws:sns:eu-west-1:123456789012:wisp-mail";
const NOW: i64 = 1_704_164_645_000; // 2024-01-02T03:04:05Z

struct Up;
impl Boxes for Up {
    fn state(&self, _u: &str) -> BoxState {
        BoxState::Running
    }
    fn port(&self, _u: &str) -> Option<u16> {
        Some(9)
    }
    fn begin(&self, _u: &str) -> Busy {
        Busy::new(|| {})
    }
    fn ensure<'a>(&'a self, _user: &'a BoxUser, _wake: bool) -> futures::future::BoxFuture<'a, Result<Running>> {
        Box::pin(async { Ok(Running { port: 9 }) })
    }
    fn secret(&self, _u: &str) -> Option<String> {
        Some("s".into())
    }
}

#[derive(Default)]
struct TheBox(Mutex<Vec<Delivery>>);
#[async_trait::async_trait]
impl Deliver for TheBox {
    async fn deliver(&self, _p: u16, _s: &str, d: &Delivery, _t: u64) -> std::result::Result<(u16, Value), String> {
        lock(&self.0).push(d.clone());
        Ok((200, json!({ "ok": true })))
    }
}

#[derive(Default)]
struct FakeWire {
    sent: Mutex<Vec<(String, String, String)>>,
    fetched: Mutex<Vec<String>>,
}
#[async_trait::async_trait]
impl Wire for FakeWire {
    async fn send(&self, from: &str, to: &str, raw: &str) -> std::result::Result<(), String> {
        lock(&self.sent).push((from.into(), to.into(), raw.into()));
        Ok(())
    }
    async fn fetch(&self, url: &str) -> std::result::Result<String, String> {
        lock(&self.fetched).push(url.into());
        Ok(String::new())
    }
}

struct World {
    mail: Arc<MailService>,
    inbox: Inbox,
    the_box: Arc<TheBox>,
    wire: Arc<FakeWire>,
    user: UserRow,
    key: rsa::RsaPrivateKey,
}

fn world() -> World {
    let db = Arc::new(Db::memory().unwrap());
    db.with(|c| c.execute("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'pia', 0)", [])).unwrap();
    let user = UserRow { id: "u1".into(), handle: "pia".into(), email: None, name: None, avatar: None, created_at: 0, disabled: 0 };
    let secrets = Arc::new(crate::secrets::Secrets::for_test(db.clone(), [7; 32]).unwrap());
    let clock = ManualClock::new(NOW);
    let the_box = Arc::new(TheBox::default());
    let inbox = Inbox::new(db.clone(), clock.clone(), Some(secrets), Arc::new(Up), the_box.clone(), InboxOpts { enabled: true, ..InboxOpts::default() }, Arc::new(|h: &str| format!("https://{h}.grid.test")));
    let key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 1024).unwrap();
    let pem = key.to_public_key().to_public_key_pem(rsa::pkcs8::LineEnding::LF).unwrap();
    let record = crate::dkim::tests::key_record();
    let txt: Arc<Txt> = Arc::new(move |name: String| {
        let r = record.clone();
        Box::pin(async move { if name == "sel._domainkey.example.com" { Ok(vec![vec![r]]) } else { Err(Lookup::NoSuchKey) } })
    });
    let wire = Arc::new(FakeWire::default());
    let opts = Opts { domain: "mail.grid.test".into(), topic_arn: ARN.into(), keys: vec![pem], outbound: Outbound::default(), send_per_hour: 2, thread_days: 7 };
    let mail = Arc::new(MailService::new(db, clock, opts, txt, wire.clone()));
    let m = mail.clone();
    let _ = inbox.delivered.set(Arc::new(move |u: &str, d: &Delivery| m.delivered(u, &d.headers, &d.body).unwrap()));
    World { mail, inbox, the_box, wire, user, key }
}

const HEAD: &str = "From: Ada <ada@example.com>\r\nSubject: in api: fix the login\r\nDate: Tue, 2 Jan 2024 03:04:00 +0000\r\nMessage-ID: <m1@example.com>";

/// SNS's notification of `raw` to `to`, signed with the pinned key.
fn sns(w: &World, raw: &str, to: &str) -> Vec<u8> {
    let msg = json!({ "notificationType": "Received", "receipt": { "action": { "type": "SNS", "encoding": "BASE64" }, "recipients": [to], "dmarcVerdict": { "status": "PASS" } }, "mail": { "source": "ada@example.com", "commonHeaders": { "from": ["Ada <ada@example.com>"] } }, "content": base64::engine::general_purpose::STANDARD.encode(raw) });
    let mut j = json!({ "Type": "Notification", "MessageId": "n1", "TopicArn": ARN, "Message": msg.to_string(), "Timestamp": "2024-01-02T03:04:05.000Z", "SignatureVersion": "2", "Signature": "AA==", "SigningCertURL": "https://sns.eu-west-1.amazonaws.com/x.pem" });
    let (_, text, _) = ses::signed_text(&j, ARN, NOW).unwrap();
    let sig = rsa::pkcs1v15::SigningKey::<Sha256>::new(w.key.clone()).sign(text.as_bytes());
    j["Signature"] = json!(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()));
    j.to_string().into_bytes()
}

#[tokio::test]
async fn a_signed_message_by_the_froms_own_domain_is_held_as_pass_and_its_reply_goes_only_to_it() {
    let w = world();
    let address = w.mail.address_of(&w.inbox, &w.user).unwrap();
    assert!(address.ends_with("@mail.grid.test"));
    assert_eq!(w.mail.address_of(&w.inbox, &w.user).unwrap(), address, "the same address when asked again");
    let raw = crate::dkim::tests::signed("example.com", HEAD, "it 500s\r\n", "from:subject:date", "");
    let ((status, _), held) = w.mail.webhook(&w.inbox, &sns(&w, &raw, &address)).await.unwrap();
    assert_eq!((status, held.len()), (200, 1));
    w.inbox.drain(&w.user).await.unwrap();
    let got = lock(&w.the_box.0).clone();
    assert_eq!(got.len(), 1);
    let h = |k: &str| got[0].headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
    assert_eq!((h(FROM_HEADER).as_str(), h(DMARC_HEADER).as_str(), h(ID_HEADER).as_str(), got[0].channel.as_str()), ("ada@example.com", "pass", "<m1@example.com>", "email"));
    let body: Value = serde_json::from_slice(&got[0].body).unwrap();
    assert_eq!((body["subject"].as_str(), body["text"].as_str(), body["date"].as_str()), (Some("in api: fix the login"), Some("it 500s\r\n"), Some("2024-01-02T03:04:00.000Z")));
    // the box answers: only to the thread's sender
    let out = w.mail.reply(&w.inbox, &w.user, &json!({ "replyTo": "<m1@example.com>", "subject": "Re: in api: fix the login", "text": "✓ On it." })).await.unwrap();
    assert!(out["messageId"].as_str().unwrap().ends_with("@mail.grid.test>"));
    let sent = lock(&w.wire.sent).clone();
    assert_eq!((sent[0].0.as_str(), sent[0].1.as_str()), (address.as_str(), "ada@example.com"));
    assert!(sent[0].2.contains("In-Reply-To: <m1@example.com>") && sent[0].2.contains("References: <m1@example.com>"));
    let err = |r: Result<Value>| r.unwrap_err().to_string();
    assert!(err(w.mail.reply(&w.inbox, &w.user, &json!({ "replyTo": "<m1@example.com>", "to": "eve@x.io", "text": "x" })).await).contains("nowhere else"));
    assert!(err(w.mail.reply(&w.inbox, &w.user, &json!({ "replyTo": "<nope@x>", "text": "x" })).await).contains("No such thread"));
    w.mail.reply(&w.inbox, &w.user, &json!({ "replyTo": "<m1@example.com>", "text": "again" })).await.unwrap();
    assert!(err(w.mail.reply(&w.inbox, &w.user, &json!({ "replyTo": "<m1@example.com>", "text": "third" })).await).contains("Too many"), "two an hour here");
}

#[tokio::test]
async fn unproved_mail_is_held_as_such_a_stranger_address_holds_nothing_and_a_forgery_is_refused() {
    let w = world();
    let address = w.mail.address_of(&w.inbox, &w.user).unwrap();
    // signed, but by another domain than the From's
    let other = crate::dkim::tests::signed("other.com", HEAD, "x\r\n", "from:subject:date", "");
    let ((s, _), held) = w.mail.webhook(&w.inbox, &sns(&w, &other, &address)).await.unwrap();
    assert_eq!((s, held.len()), (200, 1));
    w.inbox.drain(&w.user).await.unwrap();
    let got = lock(&w.the_box.0).clone();
    assert!(got[0].headers.iter().any(|(k, v)| k == DMARC_HEADER && v == "unproved"));
    assert!(w.mail.reply(&w.inbox, &w.user, &json!({ "replyTo": "<m1@example.com>", "text": "x" })).await.is_err(), "unproved: no thread to answer");
    let ((s, _), held) = w.mail.webhook(&w.inbox, &sns(&w, &other, "guess@mail.grid.test")).await.unwrap();
    assert_eq!((s, held.len()), (200, 0), "an address nobody has looks like any other");
    let mut forged: Value = serde_json::from_slice(&sns(&w, &other, &address)).unwrap();
    forged["TopicArn"] = json!("arn:aws:sns:eu-west-1:666:theirs");
    assert_eq!(w.mail.webhook(&w.inbox, forged.to_string().as_bytes()).await.unwrap().0 .0, 403);
    let auto = crate::dkim::tests::signed("example.com", &format!("{HEAD}\r\nAuto-Submitted: auto-replied"), "x\r\n", "from:subject:date", "");
    assert_eq!(w.mail.webhook(&w.inbox, &sns(&w, &auto, &address)).await.unwrap().1.len(), 0, "a machine's mail is never answered");
}
