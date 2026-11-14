//! Slack on a computer, end to end on the channels api's test hub (v1 test/slack.test.js's socket cases): the
//! dial, the hello, every envelope acked first, a linked person's mention read by the flow and answered in its
//! thread, a stranger's DM told once, `link <code>`, and a disconnect that won't come back stopping the dialling.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_channels_api::hub::WsFrame;
use wisp_channels_api::testing::{Reply, ScriptWs, TestHub};
use wisp_channels_api::{ChannelHub, Transport};

const TS: &str = "1700000000.000100";

fn hub(senders: &[&str]) -> Arc<TestHub> {
    let h = TestHub { reply: Some("✓ On it.".into()), start_as: Some("t1".into()), ..TestHub::default() }.with_cfg(
        "slack",
        json!({ "enabled": true, "botToken": "xoxb-1", "appToken": "xapp-1", "senders": senders, "linkCode": "ab12cd" }),
    );
    *h.now.lock().unwrap() = 1_700_000_000_000;
    let net = h.net.clone();
    net.replies.lock().unwrap().extend([
        Reply::json("auth.test", json!({ "ok": true, "user_id": "UBOT", "user": "wisp" })),
        Reply::json("apps.connections.open", json!({ "ok": true, "url": "wss://slack/socket?ticket=x" })),
        Reply::json("chat.postMessage", json!({ "ok": true, "ts": "1700000001.0001" })),
    ]);
    Arc::new(h)
}

fn envelope(id: &str, event: &Value) -> WsFrame {
    ScriptWs::text(&json!({ "type": "events_api", "envelope_id": id, "payload": { "event_id": format!("Ev{id}"), "event": event } }))
}

fn transport(h: &Arc<TestHub>) -> Arc<dyn Transport> {
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    wisp_slack::transport(dyn_hub)
}

#[tokio::test]
async fn a_linked_persons_mention_is_acked_read_by_the_flow_and_answered_in_its_thread() {
    let h = hub(&["U1"]);
    h.ws.push(vec![
        ScriptWs::text(&json!({ "type": "hello" })),
        envelope("e1", &json!({ "type": "app_mention", "user": "U1", "channel": "C1", "ts": TS, "text": "<@UBOT> in api fix the login" })),
        ScriptWs::text(&json!({ "type": "disconnect", "reason": "invalid_auth" })),
    ]);
    let t = transport(&h);
    t.start(h.stop.clone()).await;
    assert_eq!(h.ws.sent.lock().unwrap().first().map(String::as_str), Some(r#"{"envelope_id":"e1"}"#), "acked first");
    assert!(h.ws.urls.lock().unwrap()[0].contains("ticket"));
    h.run_spawned().await;
    let c = h.conversed();
    assert_eq!(c.len(), 1);
    assert_eq!(
        (c[0].channel.as_str(), c[0].sender.as_str(), c[0].text.as_str(), c[0].session.as_deref()),
        ("slack", "U1", "in api fix the login", None)
    );
    let posts = h.net.sent("chat.postMessage");
    assert_eq!(
        (posts[0]["channel"].as_str(), posts[0]["thread_ts"].as_str(), posts[0]["text"].as_str()),
        (Some("C1"), Some(TS), Some("✓ On it."))
    );
    assert_eq!(h.remote_of("t1").unwrap()["slack"], json!({ "channel": "C1", "ts": TS }), "the task keeps its thread");
    assert_eq!(h.started_from("t1").map(|s| s.0), Some("slack".into()));
    assert!(h.last_mark("slack").unwrap().error.unwrap().contains("Check the tokens"), "a disconnect that won't come back stops it");
    assert_eq!(h.ws.urls.lock().unwrap().len(), 1, "and it doesn't dial again");
}

#[tokio::test]
async fn a_stranger_is_told_once_and_link_with_the_code_lets_them_in() {
    let h = hub(&[]);
    let dm = |id: &str, text: &str| {
        envelope(id, &json!({ "type": "message", "channel_type": "im", "user": "U9", "channel": "D9", "ts": TS, "text": text }))
    };
    h.ws.push(vec![
        ScriptWs::text(&json!({ "type": "hello" })),
        dm("e1", "fix it"),
        dm("e2", "link nope"),
        dm("e3", "link ab12cd"),
        ScriptWs::text(&json!({ "type": "disconnect", "reason": "token_revoked" })),
    ]);
    let t = transport(&h);
    t.start(h.stop.clone()).await;
    h.run_spawned().await;
    assert!(h.conversed().is_empty(), "nothing a stranger says is read");
    let said: Vec<String> = h.net.sent("chat.postMessage").iter().map(|b| b["text"].as_str().unwrap_or_default().to_owned()).collect();
    assert!(said[0].contains("only answers people linked"), "{said:?}");
    assert!(said.iter().any(|s| s.contains("doesn’t match")), "{said:?}");
    assert!(said.last().unwrap().contains("Linked to wisp"), "{said:?}");
    assert_eq!(h.cfg("slack")["senders"], json!(["U9"]));
}

#[tokio::test]
async fn a_dropped_socket_is_dialled_again_after_a_wait() {
    let h = hub(&["U1"]);
    h.ws.push(vec![ScriptWs::text(&json!({ "type": "hello" }))]);
    h.ws.push(vec![ScriptWs::text(&json!({ "type": "disconnect", "reason": "link_disabled" }))]);
    let t = transport(&h);
    t.start(h.stop.clone()).await;
    assert_eq!(h.ws.urls.lock().unwrap().len(), 2, "dialled again");
    assert!(!h.sleeps.lock().unwrap().is_empty(), "after a wait");
}

#[tokio::test]
async fn a_socket_that_goes_quiet_is_closed_at_the_next_beat_and_dialled_again() {
    let h = hub(&["U1"]);
    h.ws.push(vec![ScriptWs::text(&json!({ "type": "hello" })), wisp_channels_api::testing::quiet()]);
    h.ws.push(vec![ScriptWs::text(&json!({ "type": "disconnect", "reason": "invalid_auth" }))]);
    let t = transport(&h);
    t.start(h.stop.clone()).await;
    assert!(h.ws.sent.lock().unwrap().iter().any(|s| s == "<ping>"), "a beat after the hello");
    assert_eq!(h.ws.urls.lock().unwrap().len(), 2, "the quiet one closed, a new one dialled");
}

fn click(id: &str, user: &str, value: &Value) -> WsFrame {
    let payload = json!({ "type": "block_actions", "trigger_id": format!("tr{id}"), "user": { "id": user }, "container": { "channel_id": "C1" },
        "message": { "ts": "1700000001.0001", "thread_ts": TS, "text": "✓ Fix the login", "blocks": [{ "type": "section" }, { "type": "actions" }] },
        "actions": [{ "action_id": "wisp:0", "action_ts": "1700000000.5", "value": value.to_string() }] });
    ScriptWs::text(&json!({ "type": "interactive", "envelope_id": id, "payload": payload }))
}

/// v1 slack.js `#click`: a signed button answers through wisp and the message says what and who; a forged one,
/// or a stranger's click, does nothing but tell the clicker.
#[tokio::test]
async fn a_signed_button_answers_and_says_who_and_a_forged_one_does_nothing() {
    let h = hub(&["U1"]);
    h.net
        .replies
        .lock()
        .unwrap()
        .extend([Reply::json("chat.update", json!({ "ok": true })), Reply::json("chat.postEphemeral", json!({ "ok": true }))]);
    let good = json!({ "k": "a", "s": "t1", "r": "ask1", "i": 0, "sig": "sig.t1.a.ask1.0" });
    let forged = json!({ "k": "a", "s": "t1", "r": "ask1", "i": 0, "sig": "nope" });
    h.ws.push(vec![
        ScriptWs::text(&json!({ "type": "hello" })),
        click("c1", "U1", &good),
        click("c2", "U1", &forged),
        click("c3", "U7", &good),
        ScriptWs::text(&json!({ "type": "disconnect", "reason": "invalid_auth" })),
    ]);
    let t = transport(&h);
    t.start(h.stop.clone()).await;
    assert_eq!(h.ws.sent.lock().unwrap().iter().filter(|s| s.contains("envelope_id")).count(), 3, "every click acked");
    h.run_spawned().await;
    let up = h.net.sent("chat.update");
    assert_eq!(up.len(), 1, "only the signed one, from a linked person");
    let blocks = up[0]["blocks"].as_array().unwrap();
    assert!(!blocks.iter().any(|b| b["type"] == "actions"), "its buttons go");
    assert_eq!(blocks.last().unwrap()["elements"][0]["text"], "✓ Done. · <@U1>");
    let only: Vec<String> = h.net.sent("chat.postEphemeral").iter().map(|b| b["text"].as_str().unwrap_or_default().to_owned()).collect();
    assert_eq!(only, ["That button doesn’t work any more."], "a stranger's click: silence");
}
