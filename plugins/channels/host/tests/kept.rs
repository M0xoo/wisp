//! What the hub keeps outlives a restart (`chan_task`, `chan_kept`): a task a channel started still reports back
//! there after wisp.channels restarts, and Telegram keeps its link and its poll offset (so a `/new` never runs twice
//! and the chat needn't be linked again). The restart is the plugin switched off and on, on the same store.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels::ChannelsPlugin;
use wisp_channels_api::views::{Msg, SessionView};
use wisp_channels_api::{ChannelHub, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_kernel::services::{NetRequest, NetResponse};
use wisp_kernel::{BoxFuture, Caller, CancellationToken, Kernel, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::{SessionDeleted, TurnEnded};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::TestApp;

type Published = Arc<Mutex<Vec<(String, Msg)>>>;
type HubSlot = Arc<Mutex<Option<Arc<dyn ChannelHub>>>>;

/// A phone transport that answers only for the tasks that started on it (it `reports` none).
struct Fake(Published);
#[async_trait]
impl Transport for Fake {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn ready(&self) -> bool {
        true
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Phone
    }
    async fn start(&self, _stop: CancellationToken) {}
    async fn publish(&self, msg: &Msg, s: Option<&SessionView>) -> Result<()> {
        self.0.lock().unwrap().push((s.map(|s| s.id.clone()).unwrap_or_default(), msg.clone()));
        Ok(())
    }
}
struct Def(Published, HubSlot);
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        *self.1.lock().unwrap() = Some(hub);
        Arc::new(Fake(self.0.clone()))
    }
}

/// wisp.runtime as the report reads it: one task, `s1`, with a finished turn.
struct Runtime(Option<(Published, HubSlot)>);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<r::Get, _, _>(|_, _, a: r::IdArgs| async move {
            if a.id.0 == "gone" {
                return Err(wisp_kernel::WireError::not_found("no task gone"));
            }
            Ok(serde_json::from_value(
                json!({ "id": a.id.0, "title": "Fix login", "cwd": "/w/api", "agent": "claude", "model": "", "effort": "",
                "mode": "edits", "state": "review", "createdAt": 0, "updatedAt": 0 }),
            )
            .unwrap())
        });
        s.command::<r::Turns, _, _>(|_, _, _a: r::TurnsArgs| async move {
            Ok(serde_json::from_value(json!([{ "id": "t1", "sessionId": "s1", "idx": 0, "prompt": "fix it", "agent": "claude", "model": "",
                "effort": "", "mode": "edits", "status": "done", "startedAt": 0,
                "presentation": { "v": 1, "blocks": [{ "type": "hero", "title": "Login fixed", "summary": "Refresh retries.", "status": "done" }] } }]))
            .unwrap())
        });
        if let Some((out, slot)) = &self.0 {
            s.contribute(&TRANSPORTS, Arc::new(Def(out.clone(), slot.clone())) as Arc<dyn TransportDef>);
        }
        Ok(())
    }
}

#[derive(Default)]
struct Secrets(Mutex<BTreeMap<String, String>>);
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

/// Telegram's Bot API: the first `getUpdates` hands one update (the link code from chat 42), later ones wait.
#[derive(Default)]
struct BotApi {
    sent: Mutex<Vec<(String, Value)>>,
    polls: Mutex<u32>,
}
impl BotApi {
    fn sent(&self, method: &str) -> Vec<Value> {
        self.sent.lock().unwrap().iter().filter(|(m, _)| m == method).map(|(_, b)| b.clone()).collect()
    }
}
impl wisp_kernel::services::Net for BotApi {
    fn fetch(&self, req: NetRequest) -> BoxFuture<'static, Result<NetResponse>> {
        let method = req.url.rsplit('/').next().unwrap_or_default().to_owned();
        let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
        self.sent.lock().unwrap().push((method.clone(), body));
        let answer = match method.as_str() {
            "getUpdates" => {
                let n = {
                    let mut p = self.polls.lock().unwrap();
                    *p += 1;
                    *p
                };
                if n > 1 {
                    return Box::pin(std::future::pending());
                }
                json!({ "ok": true, "result": [{ "update_id": 7, "message": { "message_id": 70, "chat": { "id": 42, "type": "private", "first_name": "Ada" }, "text": "/start 123456" } }] })
            }
            _ => json!({ "ok": true, "result": { "message_id": 900 } }),
        };
        Box::pin(async move { Ok(NetResponse { status: 200, headers: Vec::new(), body: answer.to_string().into_bytes() }) })
    }
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

async fn row(store: &Store, kind: &'static str, id: &'static str) -> Option<Value> {
    store.read_async(move |r| Ok(r.get(kind, id)?.and_then(|x| x.get("body").cloned()))).await.unwrap()
}

async fn restart(k: &Kernel) {
    k.set_enabled("wisp.channels", false).await.unwrap();
    k.set_enabled("wisp.channels", true).await.unwrap();
}

fn finished(id: &str) -> TurnEnded {
    serde_json::from_value(
        json!({ "sessionId": id, "turnId": "t1", "status": "done", "interrupted": false, "agent": "claude", "model": "", "inner": false }),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_started_from_a_channel_still_reports_back_after_the_plugin_restarts() {
    let (out, slot) = (Published::default(), HubSlot::default());
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let secrets: wisp_kernel::services::SecretsService = Arc::new(Secrets::default());
    let k = TestApp::new()
        .service(store.clone())
        .service(secrets)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(Runtime(Some((out.clone(), slot.clone()))))
        .start()
        .await;
    k.call(
        Caller::user(),
        "resources.apply",
        json!({ "resources": [{ "kind": "channel", "name": "fake", "spec": { "transport": "fake", "enabled": true } }] }),
    )
    .await
    .unwrap();
    eventually("the transport is made", async || slot.lock().unwrap().is_some()).await;
    let hub = slot.lock().unwrap().clone().unwrap();
    hub.mark_started("s1", "fake", Some("ada"));
    hub.set_remote("s1", serde_json::Map::from_iter([("fake".into(), json!({ "thread": "T9", "ids": [3, 4] }))]));
    eventually("its origin is written", async || {
        row(&store, "chan_task", "s1").await.is_some_and(|b| b["remote"]["fake"]["thread"] == "T9")
    })
    .await;

    *slot.lock().unwrap() = None;
    restart(&k).await;
    eventually("the transport is made again", async || slot.lock().unwrap().is_some()).await;
    let hub = slot.lock().unwrap().clone().unwrap();
    assert_eq!(hub.started_from("s1"), Some(("fake".to_owned(), Some("ada".to_owned()))), "who started it, read back");
    assert_eq!(hub.remote_of("s1").unwrap()["fake"]["ids"], json!([3, 4]), "its thread and message ids, read back");

    let ctx = k.ctx("wisp.runtime").unwrap();
    ctx.emit(&ctx.root_call(), &finished("s1"));
    eventually("the report goes back to the chat", async || !out.lock().unwrap().is_empty()).await;
    let got = out.lock().unwrap().clone();
    assert_eq!((got[0].0.as_str(), got[0].1.text.as_str()), ("s1", "Login fixed\n\nRefresh retries."));

    ctx.emit(&ctx.root_call(), &SessionDeleted { id: SessionId::from("s1") });
    eventually("a deleted task's origin goes", async || row(&store, "chan_task", "s1").await.is_none()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn telegram_keeps_its_link_and_offset_across_a_restart() {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let secrets = Arc::new(Secrets::default());
    let bot = Arc::new(BotApi::default());
    let (sec, net): (wisp_kernel::services::SecretsService, wisp_kernel::services::NetService) = (secrets.clone(), bot.clone());
    let k = TestApp::new()
        .service(store.clone())
        .service(sec)
        .service(net)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(wisp_telegram::TelegramPlugin)
        .with(Runtime(None))
        .start()
        .await;
    k.call(
        Caller::user(),
        "resources.apply",
        json!({ "resources": [{ "kind": "channel", "name": "tg", "spec": { "transport": "telegram", "enabled": true, "token": "123:abc", "routing": { "linkCode": "123456" } } }] }),
    )
    .await
    .unwrap();
    eventually("chat 42 links with the code and the offset moves past its update", async || {
        row(&store, "chan_kept", "telegram").await.is_some_and(|b| b["kept"]["chatId"] == "42" && b["kept"]["offset"] == 8)
    })
    .await;
    let kept = row(&store, "chan_kept", "telegram").await.unwrap();
    assert!(kept["kept"].get("token").is_none() && !kept.to_string().contains("123:abc"), "the token never reaches the store: {kept}");
    assert!(kept["kept"].get("enabled").is_none(), "nor a declared field");
    assert_eq!(bot.sent("getUpdates")[0]["offset"], 0);

    let polled = bot.sent("getUpdates").len();
    restart(&k).await;
    eventually("it polls again", async || bot.sent("getUpdates").len() > polled).await;
    assert_eq!(bot.sent("getUpdates")[polled]["offset"], 8, "the update it handled isn't handed back");
    let before = bot.sent("sendMessage").len();
    k.call(Caller::user(), "channels.test", json!({})).await.unwrap();
    let said = bot.sent("sendMessage");
    assert_eq!(said.len(), before + 1, "still linked: a test goes to the chat");
    assert_eq!(said[before]["chat_id"], "42");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_bot_token_while_off_starts_telegrams_kept_state_over() {
    // the rule `kinds::keep_over` keeps in memory, across a restart: the row's mark is the token's hash
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let secrets = Arc::new(Secrets::default());
    secrets.0.lock().unwrap().insert("tg/token".into(), "123:abc".into());
    let bot = Arc::new(BotApi::default());
    let (sec, net): (wisp_kernel::services::SecretsService, wisp_kernel::services::NetService) = (secrets.clone(), bot.clone());
    let k = TestApp::new()
        .service(store.clone())
        .service(sec)
        .service(net)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(wisp_telegram::TelegramPlugin)
        .with(Runtime(None))
        .start()
        .await;
    k.call(
        Caller::user(),
        "resources.apply",
        json!({ "resources": [{ "kind": "channel", "name": "tg", "spec": { "transport": "telegram", "enabled": true, "token": "${secret:tg/token}", "routing": { "linkCode": "123456" } } }] }),
    )
    .await
    .unwrap();
    eventually("linked", async || row(&store, "chan_kept", "telegram").await.is_some_and(|b| b["kept"]["chatId"] == "42")).await;
    k.set_enabled("wisp.channels", false).await.unwrap();
    secrets.0.lock().unwrap().insert("tg/token".into(), "999:other".into());
    let polled = bot.sent("getUpdates").len();
    k.set_enabled("wisp.channels", true).await.unwrap();
    eventually("the other bot polls", async || bot.sent("getUpdates").len() > polled).await;
    assert_eq!(bot.sent("getUpdates")[polled]["offset"], 0, "another bot's updates start from its own first");
    eventually("its row starts over", async || {
        row(&store, "chan_kept", "telegram").await.is_some_and(|b| b["kept"].get("chatId").is_none())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kept_origin_whose_task_was_deleted_while_off_is_dropped_at_start() {
    let (out, slot) = (Published::default(), HubSlot::default());
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let secrets: wisp_kernel::services::SecretsService = Arc::new(Secrets::default());
    let k = TestApp::new()
        .service(store.clone())
        .service(secrets)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(Runtime(Some((out.clone(), slot.clone()))))
        .start()
        .await;
    k.call(
        Caller::user(),
        "resources.apply",
        json!({ "resources": [{ "kind": "channel", "name": "fake", "spec": { "transport": "fake", "enabled": true } }] }),
    )
    .await
    .unwrap();
    eventually("the transport is made", async || slot.lock().unwrap().is_some()).await;
    let hub = slot.lock().unwrap().clone().unwrap();
    hub.mark_started("s1", "fake", None);
    hub.mark_started("gone", "fake", None);
    eventually("both origins are written", async || {
        row(&store, "chan_task", "s1").await.is_some() && row(&store, "chan_task", "gone").await.is_some()
    })
    .await;

    *slot.lock().unwrap() = None;
    restart(&k).await; // `gone` was deleted while wisp.channels was off: no SessionDeleted reached it
    eventually("the deleted task's origin goes", async || row(&store, "chan_task", "gone").await.is_none()).await;
    eventually("the transport is made again", async || slot.lock().unwrap().is_some()).await;
    let hub = slot.lock().unwrap().clone().unwrap();
    assert_eq!(hub.started_from("gone"), None, "nor is it held in memory");
    assert!(row(&store, "chan_task", "s1").await.is_some(), "a task that's there keeps its origin");
    assert_eq!(hub.started_from("s1"), Some(("fake".to_owned(), None)));
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_telegrams_channel_drops_its_kept_row_and_its_kept_secret() {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let secrets = Arc::new(Secrets::default());
    let bot = Arc::new(BotApi::default());
    let (sec, net): (wisp_kernel::services::SecretsService, wisp_kernel::services::NetService) = (secrets.clone(), bot.clone());
    let k = TestApp::new()
        .service(store.clone())
        .service(sec)
        .service(net)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(wisp_telegram::TelegramPlugin)
        .with(Runtime(None))
        .start()
        .await;
    let tg = json!({ "kind": "channel", "name": "tg", "spec": { "transport": "telegram", "enabled": true, "token": "123:abc", "routing": { "linkCode": "123456" } } });
    k.call(Caller::user(), "resources.apply", json!({ "resources": [tg] })).await.unwrap();
    eventually("linked", async || row(&store, "chan_kept", "telegram").await.is_some_and(|b| b["kept"]["chatId"] == "42")).await;
    // a webhook's secret as `put_kept` keeps it (polling here keeps none)
    secrets.0.lock().unwrap().insert("channels/kept/telegram/hook.secret".into(), "\"s\"".into());

    k.call(Caller::user(), "resources.apply", json!({ "resources": [], "destroy": ["channel.tg"], "trust": true })).await.unwrap();
    eventually("its row goes", async || row(&store, "chan_kept", "telegram").await.is_none()).await;
    eventually("its kept secret goes", async || !secrets.0.lock().unwrap().contains_key("channels/kept/telegram/hook.secret")).await;
    assert!(secrets.0.lock().unwrap().contains_key("channels/sign"), "the hub's own key stays");

    // declared again with the same bot: it starts over (no link carried over)
    let polled = bot.sent("getUpdates").len();
    k.call(Caller::user(), "resources.apply", json!({ "resources": [{ "kind": "channel", "name": "tg", "spec": { "transport": "telegram", "enabled": true, "token": "123:abc" } }] }))
        .await
        .unwrap();
    eventually("it polls again", async || bot.sent("getUpdates").len() > polled).await;
    assert_eq!(bot.sent("getUpdates")[polled]["offset"], 0, "nothing kept from before the removal");
}
