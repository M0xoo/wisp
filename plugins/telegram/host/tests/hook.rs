//! Telegram on a sleeping cloud wisp (v1 test/telegram-webhook.test.js; F-chan-9): the box points the bot's webhook
//! at its grid URL instead of polling; each update the grid held is checked with the webhook's secret, runs once
//! (a retry is a duplicate), and a stranger's gets the 403 that stops the grid paying for its wakes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_channels_api::ChannelHub;
use wisp_channels_api::hub::{BoxGrid, ChannelUrl};
use wisp_channels_api::testing::{Reply, TestHub};
use wisp_channels_api::transport::InboundOpts;

const URL: &str = "https://grid/in/telegram/abc";

fn hub(held: bool) -> Arc<TestHub> {
    let h = TestHub {
        reply: Some("✓ On it.".into()),
        on_box: Some(BoxGrid { grid: "https://grid".into(), auth: "a".into() }),
        box_url: Some(ChannelUrl { url: (!held).then(|| URL.into()), held, ..ChannelUrl::default() }),
        ..TestHub::default()
    }
    .with_cfg("telegram", json!({ "enabled": true, "token": "123:abc", "chatId": 42, "options": true }));
    h.net.replies.lock().unwrap().extend([
        Reply::json("getWebhookInfo", json!({ "ok": true, "result": { "url": "" } })),
        Reply::json("setWebhook", json!({ "ok": true, "result": true })),
        Reply::json("sendMessage", json!({ "ok": true, "result": { "message_id": 900 } })),
    ]);
    Arc::new(h)
}

fn update(id: i64, chat: i64, text: &str) -> Vec<u8> {
    json!({ "update_id": id, "message": { "message_id": id, "chat": { "id": chat, "type": "private" }, "text": text } })
        .to_string()
        .into_bytes()
}

fn secret_of(h: &TestHub) -> String {
    h.net.sent("setWebhook")[0]["secret_token"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn on_a_box_the_webhook_is_the_grid_url_and_each_held_update_runs_once_with_the_secret() {
    let h = hub(false);
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_telegram::transport(dyn_hub);
    t.start(h.stop.clone()).await;
    let set = h.net.sent("setWebhook");
    assert_eq!(set.len(), 1);
    assert_eq!(set[0]["url"], URL);
    assert!(h.net.sent("getUpdates").is_empty(), "a box never long-polls");
    let secret = secret_of(&h);
    assert_eq!(secret.len(), 64, "32 random bytes");
    assert_eq!(h.last_mark("telegram").unwrap().more.get("webhook"), Some(&Value::Bool(true)));

    let opts = InboundOpts { at_ms: 0, verified: false };
    let hd = |s: &str| vec![("x-telegram-bot-api-secret-token".to_owned(), s.to_owned())];
    assert_eq!(t.inbound(&update(5, 42, "fix the login"), &hd("wrong"), opts).await.status, 403, "Telegram's secret only");
    assert_eq!(h.conversed().len(), 0);
    let r = t.inbound(&update(5, 42, "fix the login"), &hd(&secret), opts).await;
    assert_eq!(r.status, 200);
    assert_eq!(h.conversed().iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["fix the login"]);
    let again = t.inbound(&update(5, 42, "fix the login"), &hd(&secret), opts).await;
    assert_eq!((again.status, again.body["duplicate"].as_bool()), (200, Some(true)), "the grid's retry runs nothing twice");
    assert_eq!(h.conversed().len(), 1);
    let stranger = t.inbound(&update(6, 7, "hi"), &hd(&secret), opts).await;
    assert_eq!(stranger.status, 403, "a stranger's update: the grid stops waking for it");
    assert_eq!(h.conversed().len(), 1);
    assert_eq!(t.inbound(b"{}", &hd(&secret), opts).await.status, 400);

    // a restart keeps the secret and the hook: held updates still carry it
    t.start(h.stop.clone()).await;
    assert_eq!(h.net.sent("setWebhook").len(), 2, "getWebhookInfo says Telegram lost it, so it's set again");
    assert_eq!(h.net.sent("setWebhook")[1]["secret_token"], secret.as_str());
}

#[tokio::test]
async fn when_the_grid_holds_the_webhook_the_box_never_touches_it_and_takes_what_the_grid_checked() {
    let h = hub(true);
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_telegram::transport(dyn_hub);
    t.start(h.stop.clone()).await;
    assert!(h.net.sent("setWebhook").is_empty() && h.net.sent("getUpdates").is_empty(), "one call here would take it back");
    let r = t.inbound(&update(9, 42, "status"), &Vec::new(), InboundOpts { at_ms: 0, verified: true }).await;
    assert_eq!(r.status, 200, "the grid checked its own secret");
    assert_eq!(h.conversed().len(), 1);
    let unverified = t.inbound(&update(10, 42, "status"), &Vec::new(), InboundOpts { at_ms: 0, verified: false }).await;
    assert_eq!(unverified.status, 403, "no secret here to check it with");
}
