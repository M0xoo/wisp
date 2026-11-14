//! Settings → Phone's commands (F-chan-13): `channels.setup` saves a channel's tokens to secrets only (no row, change
//! or file of the store ever holds one), `channels.status` says where each channel stands, `channels.test` sends
//! through the transport and says what its service answered (v1 said "Test sent" when every channel had failed).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels::ChannelsPlugin;
use wisp_channels_api::views::{Msg, SessionView};
use wisp_channels_api::{ChannelHub, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_kernel::services::{NetRequest, NetResponse};
use wisp_kernel::{BoxFuture, Caller, CancellationToken, Kernel, Manifest, Plugin, Result, Setup};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::TestApp;

// Assembled at run time, so this file holds no token-shaped string.
fn tg_token() -> String {
    ["987654", ":", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].concat()
}
fn dc_token() -> String {
    ["MTIzNDU2Nzg5", ".", "GhIjKl", ".", "abcdefghijklmnop"].concat()
}

#[derive(Default)]
struct Secrets(Mutex<BTreeMap<String, String>>);
impl Secrets {
    fn get(&self, k: &str) -> Option<String> {
        self.0.lock().unwrap().get(k).cloned()
    }
}
impl wisp_kernel::services::Secrets for Secrets {
    fn get(&self, key: &str) -> BoxFuture<'static, Result<Option<String>>> {
        let v = self.0.lock().unwrap().get(key).cloned();
        Box::pin(async move { Ok(v) })
    }
    fn set(&self, key: &str, value: &str) -> BoxFuture<'static, Result<()>> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Box::pin(async { Ok(()) })
    }
    fn delete(&self, key: &str) -> BoxFuture<'static, Result<()>> {
        self.0.lock().unwrap().remove(key);
        Box::pin(async { Ok(()) })
    }
    fn keys(&self, _prefix: &str) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// ntfy and Telegram's servers: ntfy's publish answers `ntfy_status`, its poll and Telegram's long poll wait.
struct Net {
    ntfy_status: AtomicU16,
    posts: Mutex<Vec<(String, Value)>>,
    /// Telegram can't be reached: the error names the URL, as a real client's does
    tg_down: std::sync::atomic::AtomicBool,
}
impl Default for Net {
    fn default() -> Self {
        Self { ntfy_status: AtomicU16::new(200), posts: Mutex::default(), tg_down: std::sync::atomic::AtomicBool::new(false) }
    }
}
impl wisp_kernel::services::Net for Net {
    fn fetch(&self, req: NetRequest) -> BoxFuture<'static, Result<NetResponse>> {
        let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
        self.posts.lock().unwrap().push((req.url.clone(), body));
        if req.url.contains("telegram") && self.tg_down.load(Ordering::SeqCst) {
            let url = req.url.clone();
            return Box::pin(async move { Err(wisp_kernel::WireError::unavailable(format!("{url}: connection refused"))) });
        }
        if req.url.contains("getUpdates") || (req.method == "GET" && req.url.contains("ntfy")) {
            return Box::pin(std::future::pending());
        }
        let status = if req.url.contains("ntfy") { self.ntfy_status.load(Ordering::SeqCst) } else { 200 };
        let answer = json!({ "ok": true, "result": { "message_id": 1 } }).to_string().into_bytes();
        Box::pin(async move { Ok(NetResponse { status, headers: Vec::new(), body: answer }) })
    }
}

/// A channel that answers only where it was asked (as Slack does), for the test's third outcome.
struct Threaded;
#[async_trait]
impl Transport for Threaded {
    fn name(&self) -> &'static str {
        "threaded"
    }
    fn ready(&self) -> bool {
        true
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }
    async fn start(&self, _stop: CancellationToken) {}
    async fn publish(&self, _msg: &Msg, _s: Option<&SessionView>) -> Result<()> {
        Ok(())
    }
}
struct ThreadedDef;
impl TransportDef for ThreadedDef {
    fn name(&self) -> &'static str {
        "threaded"
    }
    fn create(&self, _hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new(Threaded)
    }
}
/// Discord, as far as linking goes: once on, someone has linked (`senders`) and its service answered.
struct Linked(Arc<dyn ChannelHub>);
#[async_trait]
impl Transport for Linked {
    fn name(&self) -> &'static str {
        "discord"
    }
    fn ready(&self) -> bool {
        true
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }
    async fn start(&self, _stop: CancellationToken) {
        if self.0.cfg("discord").get("senders").is_none() {
            self.0.set_cfg("discord", json!({ "senders": ["u1"] }));
        }
        self.0.mark("discord", wisp_channels_api::Status { ok: Some(true), ..wisp_channels_api::Status::default() });
    }
    async fn publish(&self, _msg: &Msg, _s: Option<&SessionView>) -> Result<()> {
        Ok(())
    }
}
struct LinkedDef;
impl TransportDef for LinkedDef {
    fn name(&self) -> &'static str {
        "discord"
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new(Linked(hub))
    }
    fn secrets(&self) -> &'static [&'static str] {
        &["token", "publicKey", "linkCode"] // as wisp.discord's
    }
}
struct Extra;
impl Plugin for Extra {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.threaded", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&TRANSPORTS, Arc::new(ThreadedDef) as Arc<dyn TransportDef>);
        s.contribute(&TRANSPORTS, Arc::new(LinkedDef) as Arc<dyn TransportDef>);
        Ok(())
    }
}

/// The spec of the resource named `name` anywhere in an export.
fn find(v: &Value, name: &str) -> Option<Value> {
    match v {
        Value::Object(o) if o.get("name").and_then(Value::as_str) == Some(name) && o.get("spec").is_some() => o.get("spec").cloned(),
        Value::Object(o) => o.values().find_map(|x| find(x, name)),
        Value::Array(a) => a.iter().find_map(|x| find(x, name)),
        _ => None,
    }
}

struct App {
    k: Kernel,
    store: Store,
    secrets: Arc<Secrets>,
    net: Arc<Net>,
    dir: PathBuf,
}
impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn app(name: &str) -> App {
    let dir = std::env::temp_dir().join(format!("wisp-chan-setup-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(Location::Path(dir.join("wisp.db")), Arc::new(SystemClock)).unwrap();
    let secrets = Arc::new(Secrets::default());
    let net = Arc::new(Net::default());
    let (sec, n): (wisp_kernel::services::SecretsService, wisp_kernel::services::NetService) = (secrets.clone(), net.clone());
    let k = TestApp::new()
        .service(store.clone())
        .service(sec)
        .service(n)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(wisp_telegram::TelegramPlugin)
        .with(wisp_ntfy::NtfyPlugin)
        .with(wisp_slack::SlackPlugin)
        .with(Extra)
        .start()
        .await;
    App { k, store, secrets, net, dir }
}

impl App {
    async fn call(&self, id: &str, args: Value) -> Value {
        self.k.call(Caller::user(), id, args).await.unwrap_or_else(|e| panic!("{id}: {}", e.message))
    }
    async fn status(&self, transport: &str) -> Value {
        let all = self.call("channels.status", json!({})).await;
        all["channels"].as_array().unwrap().iter().find(|c| c["transport"] == transport).cloned().unwrap()
    }
    /// Settings → Phone's row for `transport` (`plugin:wisp.channels:phone`), as the pane gets it.
    async fn phone_row(&self, transport: &str) -> Option<Value> {
        let t = transport.to_owned();
        let rows = self.store.read_async(|r| r.query("chan_phone", &wisp_store::Query::new())).await.unwrap();
        rows.into_iter().find(|r| r.get("id").and_then(Value::as_str) == Some(&t)).and_then(|r| r.get("body").cloned())
    }
    async fn notification(&self, name: &str) -> Option<Value> {
        let v = self.call("resources.export", json!({ "kinds": ["notification"] })).await;
        find(&v, name)
    }
    async fn channel_row(&self) -> Option<Value> {
        let rows = self.store.read_async(|r| r.query("channels_spec_channel", &wisp_store::Query::new())).await.unwrap();
        rows.into_iter().find_map(|r| r.get("body").cloned())
    }
    /// Every byte the store has on disk: its rows, its change feed, its write-ahead log.
    fn on_disk(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(&self.dir).unwrap() {
            out.extend(std::fs::read(e.unwrap().path()).unwrap_or_default());
        }
        out
    }
}

fn holds(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

async fn eventually(what: &str, f: impl AsyncFn() -> bool) {
    for _ in 0..400 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never: {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_telegram_token_set_up_from_settings_is_kept_in_secrets_only_never_in_a_row_a_change_or_the_status() {
    let a = app("tg").await;
    let token = tg_token();
    let out = a.call("channels.setup", json!({ "transport": "telegram", "enabled": true, "secrets": { "token": token } })).await;
    assert_eq!(out["saved"], json!(["token"]), "{out}");
    assert_eq!(out["enabled"], true);
    assert_eq!(a.secrets.get("channels/telegram/token").as_deref(), Some(token.as_str()), "the token is in secrets.json");
    let row = a.channel_row().await.unwrap();
    assert_eq!(row["token"], "${secret:channels/telegram/token}", "the resource names the secret: {row}");
    let code = out["linkCode"].as_str().unwrap().to_owned();
    assert!(code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()), "a code to send the bot: {code}");

    // the transport got the token itself: it's polling Telegram's API with it
    eventually("Telegram is asked for updates with the saved token", async || {
        a.net.posts.lock().unwrap().iter().any(|(u, _)| u.contains(&token) && u.contains("getUpdates"))
    })
    .await;

    let status = a.call("channels.status", json!({})).await.to_string();
    let export = a.call("resources.export", json!({ "kinds": ["channel"] })).await.to_string();
    eventually("the link code is kept (in secrets)", async || a.secrets.get("channels/kept/telegram/linkCode").is_some()).await;
    let disk = a.on_disk();
    for (what, hay) in [("the store's files", disk.as_slice()), ("channels.status", status.as_bytes()), ("an export", export.as_bytes())] {
        assert!(!holds(hay, &token), "{what} holds the token");
    }
    assert!(!holds(&disk, &code), "nor does the store hold the link code");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_token_is_refused_by_its_field_and_nothing_is_written() {
    let a = app("bad").await;
    let e =
        a.k.call(Caller::user(), "channels.setup", json!({ "transport": "slack", "enabled": true, "secrets": { "botToken": "nope" } }))
            .await
            .unwrap_err();
    assert!(e.message.starts_with("secrets.botToken: The bot token starts with xoxb-"), "{}", e.message);
    let e =
        a.k.call(Caller::user(), "channels.setup", json!({ "transport": "telegram", "secrets": { "token": "${secret:channels/sign}" } }))
            .await
            .unwrap_err();
    assert!(e.message.contains("not a reference"), "another secret can't be named into a channel: {}", e.message);
    let e =
        a.k.call(Caller::user(), "channels.setup", json!({ "transport": "ntfy", "settings": { "topic": "my topic!" } })).await.unwrap_err();
    assert!(e.message.starts_with("settings.topic:"), "{}", e.message);
    let e = a.k.call(Caller::user(), "channels.setup", json!({ "transport": "irc" })).await.unwrap_err();
    assert!(e.message.starts_with("transport:"), "{}", e.message);
    assert!(a.channel_row().await.is_none(), "no channel was declared");
    assert!(a.secrets.0.lock().unwrap().keys().all(|k| !k.starts_with("channels/slack") && !k.starts_with("channels/telegram")));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_set_up_a_channel_or_read_their_state() {
    let a = app("agent").await;
    for id in ["channels.setup", "channels.status", "channels.test"] {
        let e = a.k.call(Caller::agent("s1", false), id, json!({ "transport": "ntfy", "enabled": true })).await.unwrap_err();
        assert_eq!(e.code, wisp_kernel::Code::Forbidden, "{id}: {}", e.message);
    }
    assert!(a.channel_row().await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn ntfy_switched_on_gets_a_random_topic_and_its_test_says_what_ntfy_answered() {
    let a = app("ntfy").await;
    let out = a.call("channels.setup", json!({ "transport": "ntfy", "enabled": true })).await;
    let topic = out["settings"]["topic"].as_str().unwrap().to_owned();
    assert!(topic.starts_with("wisp-") && topic.len() == 19, "v1's random first topic: {topic}");
    assert_eq!(out["missing"], json!([]));

    // v1 toasted "Test sent" here: ntfy refused it
    a.net.ntfy_status.store(500, Ordering::SeqCst);
    let t = a.call("channels.test", json!({ "channel": "ntfy" })).await;
    assert_eq!(t[0]["outcome"], "failed", "{t}");
    assert!(t[0]["error"].as_str().unwrap().contains("500"), "{t}");
    let s = a.status("ntfy").await;
    assert_eq!((s["state"].as_str(), s["error"].as_str().map(|e| e.contains("500"))), (Some("failing"), Some(true)), "{s}");

    a.net.ntfy_status.store(200, Ordering::SeqCst);
    let t = a.call("channels.test", json!({ "channel": "ntfy" })).await;
    assert_eq!(t[0]["outcome"], "sent", "{t}");
    let sent = a.net.posts.lock().unwrap().iter().rev().find(|(u, b)| u.contains("ntfy") && b.get("topic").is_some()).cloned().unwrap();
    assert_eq!(sent.1["topic"], topic.as_str(), "to the topic shown: {}", sent.1);
    assert_eq!(a.status("ntfy").await["state"], "connected");

    // switched off: a test says so, and nothing goes
    a.call("channels.setup", json!({ "transport": "ntfy", "enabled": false })).await;
    let n = a.net.posts.lock().unwrap().len();
    let t = a.call("channels.test", json!({ "channel": "ntfy" })).await;
    assert_eq!((t[0]["outcome"].as_str(), t[0]["error"].as_str()), (Some("failed"), Some("ntfy is off: switch it on first.")));
    assert_eq!(a.net.posts.lock().unwrap().len(), n);
    assert_eq!(a.status("ntfy").await["settings"]["topic"], topic.as_str(), "off keeps its topic");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_that_answers_where_asked_says_so_instead_of_claiming_a_test_went() {
    let a = app("thread").await;
    a.call(
        "resources.apply",
        json!({ "resources": [{ "kind": "channel", "name": "t", "spec": { "transport": "threaded", "enabled": true } }] }),
    )
    .await;
    eventually("it's on", async || a.status("threaded").await["enabled"] == true).await;
    let t = a.call("channels.test", json!({ "channel": "threaded" })).await;
    assert_eq!(t, json!([{ "channel": "threaded", "outcome": "unprompted" }]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_token_again_keeps_the_link_code_another_one_relinks_and_an_empty_one_removes_it() {
    let a = app("relink").await;
    let first = a.call("channels.setup", json!({ "transport": "telegram", "secrets": { "token": tg_token() } })).await;
    assert_eq!(first["state"], "off", "saved, not switched on");
    let on = a.call("channels.setup", json!({ "transport": "telegram", "enabled": true, "secrets": { "token": tg_token() } })).await;
    let code = on["linkCode"].as_str().unwrap().to_owned();
    let again = a.call("channels.setup", json!({ "transport": "telegram", "secrets": { "token": tg_token() } })).await;
    assert_eq!(again["linkCode"].as_str(), Some(code.as_str()), "the same bot: the same code");

    let other = ["123456", ":", "BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].concat();
    let mut changed = false;
    for _ in 0..5 {
        let next = a.call("channels.setup", json!({ "transport": "telegram", "secrets": { "token": other } })).await;
        // a fresh random code: it could match the old one once in 900 000
        changed |= next["linkCode"].as_str() != Some(code.as_str());
        if changed {
            break;
        }
    }
    assert!(changed, "another bot: a new code");
    assert_eq!(a.secrets.get("channels/telegram/token").as_deref(), Some(other.as_str()));
    // the spec still names the same secret, so nothing was applied: the running transport reads the new token anyway
    eventually("Telegram polls as the new bot", async || {
        a.net.posts.lock().unwrap().iter().any(|(u, _)| u.contains(&other) && u.contains("getUpdates"))
    })
    .await;

    let gone = a.call("channels.setup", json!({ "transport": "telegram", "secrets": { "token": "" } })).await;
    assert_eq!((gone["saved"].clone(), gone["state"].clone(), gone["missing"].clone()), (json!([]), json!("incomplete"), json!(["token"])));
    assert!(a.secrets.get("channels/telegram/token").is_none(), "an empty token is removed from secrets");
    let row = a.channel_row().await.unwrap();
    assert_eq!(row["token"], "", "the resource names no secret: {row}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_service_error_that_quotes_its_request_never_shows_the_token() {
    let a = app("down").await;
    a.net.tg_down.store(true, Ordering::SeqCst);
    let token = tg_token();
    a.call("channels.setup", json!({ "transport": "telegram", "enabled": true, "secrets": { "token": token } })).await;
    eventually("Telegram reads as not working", async || a.status("telegram").await["state"] == "failing").await;
    let s = a.status("telegram").await;
    let e = s["error"].as_str().unwrap();
    assert!(e.contains("connection refused") && !e.contains(&token), "{e}");
    assert!(!a.call("channels.view", json!({})).await.to_string().contains(&token));
}

#[tokio::test(flavor = "multi_thread")]
async fn two_saves_at_once_both_land() {
    let a = app("race").await;
    let (on, tok) = tokio::join!(
        a.k.call(Caller::user(), "channels.setup", json!({ "transport": "telegram", "enabled": true })),
        a.k.call(Caller::user(), "channels.setup", json!({ "transport": "telegram", "secrets": { "token": tg_token() } })),
    );
    on.unwrap();
    tok.unwrap();
    let s = a.status("telegram").await;
    assert_eq!((s["enabled"].clone(), s["saved"].clone()), (json!(true), json!(["token"])), "{s}");
}

#[tokio::test(flavor = "multi_thread")]
async fn send_me_is_a_notification_to_the_channel_on_by_default_the_first_time_and_only_for_channels_that_send_unasked() {
    let a = app("sendme").await;
    let on = a.call("channels.setup", json!({ "transport": "ntfy", "enabled": true })).await;
    assert_eq!(on["notify"], json!(["asks", "finished"]), "v1's default: questions and finished tasks: {on}");
    let n = a.notification("phone-ntfy").await.unwrap();
    assert_eq!((n["on"].clone(), n["to"].clone()), (json!(["asks", "finished"]), json!("ntfy")), "{n}");

    // an event added to Send me's notification by hand stays when Send me changes
    a.call("resources.apply", json!({ "resources": [{ "kind": "notification", "name": "phone-ntfy", "spec": { "on": ["asks", "finished", "failed"], "to": "ntfy" } }] })).await;
    let only = a.call("channels.setup", json!({ "transport": "ntfy", "notify": ["finished"] })).await;
    assert_eq!(only["notify"], json!(["finished"]));
    assert_eq!(a.notification("phone-ntfy").await.unwrap()["on"], json!(["finished", "failed"]));
    // off and on again: what was chosen stays
    a.call("channels.setup", json!({ "transport": "ntfy", "enabled": false })).await;
    let again = a.call("channels.setup", json!({ "transport": "ntfy", "enabled": true })).await;
    assert_eq!(again["notify"], json!(["finished"]), "{again}");
    let none = a.call("channels.setup", json!({ "transport": "ntfy", "notify": [] })).await;
    assert_eq!(none["notify"], json!([]), "nothing ticked: it sends nothing");
    assert_eq!(a.status("ntfy").await["notify"], json!([]));

    let e = a.k.call(Caller::user(), "channels.setup", json!({ "transport": "slack", "notify": ["asks"] })).await.unwrap_err();
    assert!(e.message.starts_with("notify: slack answers where it was asked"), "{}", e.message);
    let e = a.k.call(Caller::user(), "channels.setup", json!({ "transport": "ntfy", "notify": ["drain"] })).await.unwrap_err();
    assert!(e.message.starts_with("notify: Send me takes asks and finished"), "{}", e.message);
    assert_eq!(a.status("ntfy").await["notify"], json!([]), "a refused one changed nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn unlink_forgets_who_was_linked_and_shows_a_new_code_that_no_row_holds() {
    let a = app("unlink").await;
    a.call("channels.setup", json!({ "transport": "discord", "enabled": true, "secrets": { "token": dc_token() } })).await;
    eventually("someone linked", async || a.status("discord").await["linked"] == 1).await;
    assert!(a.status("discord").await.get("linkCode").is_none(), "linked: no code shows");

    let out = a.call("channels.setup", json!({ "transport": "discord", "unlink": true })).await;
    assert_eq!(out["linked"], 0, "{out}");
    // nothing restarted it, so what its service last said holds: waiting for a link, not Checking… again
    assert_eq!(out["state"], "linking", "{out}");
    let code = out["linkCode"].as_str().unwrap().to_owned();
    assert!(code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()), "a new code to link with: {code}");
    eventually("the Phone row says nobody is linked", async || a.phone_row("discord").await.is_some_and(|r| r["linked"] == 0)).await;
    let row = a.phone_row("discord").await.unwrap();
    assert!(row.get("linkCode").is_none(), "{row}");
    assert!(!holds(&a.on_disk(), &code), "the code is in no row, change or file of the store");

    let e = a.k.call(Caller::user(), "channels.setup", json!({ "transport": "ntfy", "unlink": true })).await.unwrap_err();
    assert!(e.message.starts_with("unlink: ntfy links nobody"), "{}", e.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_rows_follow_where_each_channel_stands_without_anyone_asking() {
    let a = app("rows").await;
    eventually("a row per channel once the hub is up", async || a.phone_row("ntfy").await.is_some_and(|r| r["state"] == "off")).await;
    a.call("channels.setup", json!({ "transport": "ntfy", "enabled": true })).await;
    a.net.ntfy_status.store(500, Ordering::SeqCst);
    a.call("channels.test", json!({ "channel": "ntfy" })).await;
    eventually("Not working, by itself", async || a.phone_row("ntfy").await.is_some_and(|r| r["state"] == "failing")).await;
    assert!(a.status("ntfy").await["settings"]["topic"].is_string(), "channels.status still says it");
    let row = a.phone_row("ntfy").await.unwrap();
    assert!(row["settings"].get("topic").is_none(), "whoever knows the topic reads along: not on a synced row: {row}");
    // Discord's transport says it's working on its own (mark): the row turns from Checking… without a read
    a.call("channels.setup", json!({ "transport": "discord", "enabled": true, "secrets": { "token": dc_token() } })).await;
    eventually("Working, by itself", async || a.phone_row("discord").await.is_some_and(|r| r["state"] == "connected")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn slacks_manifest_is_there_before_slack_is_on() {
    let a = app("manifest").await;
    let m = a.call("channels.extra", json!({ "channel": "slack", "what": "manifest" })).await;
    assert_eq!(m["settings"]["socket_mode_enabled"], true, "on a computer: Socket Mode: {m}");
    assert_eq!(m["oauth_config"]["scopes"]["bot"][1], "chat:write");
}
