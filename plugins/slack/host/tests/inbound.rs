//! Slack on a cloud box (v1 test/slack.test.js "inbound"): Slack posts its events to the box's URL on the grid,
//! which holds them; each is checked with the signing secret against when the grid took it, a repeat is dropped,
//! and a linked person's message takes the same path as a socket's.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_channels_api::hub::BoxGrid;
use wisp_channels_api::testing::{Reply, TestHub};
use wisp_channels_api::transport::InboundOpts;
use wisp_channels_api::ChannelHub;
use wisp_slack_core::sign::signature;

const NOW_S: i64 = 1_700_000_000;

fn hub() -> Arc<TestHub> {
    let h = TestHub { reply: Some("✓ On it.".into()), on_box: Some(BoxGrid { grid: "https://grid".into(), auth: "a".into() }), ..TestHub::default() }
        .with_cfg("slack", json!({ "enabled": true, "botToken": "xoxb-1", "signingSecret": "s3cret", "senders": ["U1"] }));
    *h.now.lock().unwrap() = NOW_S * 1000;
    h.net.replies.lock().unwrap().extend([Reply::json("auth.test", json!({ "ok": true, "user_id": "UBOT", "user": "wisp" })), Reply::json("chat.postMessage", json!({ "ok": true }))]);
    Arc::new(h)
}

fn signed(body: &Value, secret: &str, ts: i64) -> (Vec<u8>, Vec<(String, String)>) {
    let raw = body.to_string().into_bytes();
    let t = ts.to_string();
    (raw.clone(), vec![("X-Slack-Request-Timestamp".into(), t.clone()), ("X-Slack-Signature".into(), signature(secret, &t, &raw))])
}

#[tokio::test]
async fn a_signed_event_is_read_once_and_a_bad_signature_or_a_stale_one_is_refused() {
    let h = hub();
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_slack::transport(dyn_hub);
    assert!(t.ready(), "a box needs the bot token and the signing secret, no app token");
    let opts = InboundOpts { at_ms: NOW_S * 1000, verified: false };
    let check = json!({ "type": "url_verification", "challenge": "xyz" });
    let (raw, hd) = signed(&check, "s3cret", NOW_S);
    let r = t.inbound(&raw, &hd, opts).await;
    assert_eq!((r.status, r.body["challenge"].as_str()), (200, Some("xyz")));
    let (raw, hd) = signed(&check, "wrong", NOW_S);
    assert_eq!(t.inbound(&raw, &hd, opts).await.status, 403);
    assert!(h.last_mark("slack").unwrap().error.is_some(), "Settings says the secret is wrong");
    let ev = json!({ "type": "event_callback", "event_id": "Ev1", "event": { "type": "app_mention", "user": "U1", "channel": "C1", "ts": format!("{NOW_S}.0001"), "text": "<@UBOT> fix the login" } });
    let (raw, hd) = signed(&ev, "s3cret", NOW_S - 10 * 60);
    assert_eq!(t.inbound(&raw, &hd, opts).await.status, 403, "signed ten minutes before the grid took it: old");
    let (raw, hd) = signed(&ev, "s3cret", NOW_S);
    let r = t.inbound(&raw, &hd, opts).await;
    assert_eq!(r.status, 200);
    r.after.expect("the work goes after the answer").await;
    assert_eq!(h.conversed().iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["fix the login"]);
    let again = t.inbound(&raw, &hd, opts).await;
    assert!(again.after.is_none() && again.body["seen"] == true, "a repeat isn't read twice");
}
