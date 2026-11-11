//! Discord on a computer, end to end on the channels api's test hub (v1 test/discord.test.js's gateway cases): the
//! identify, a linked person's mention answered in a thread made on it, a stranger's DM told once, `link <code>`, a
//! dropped connection resumed, a quiet one ended at its unanswered beat, and a fatal close stopping the dialling.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_channels_api::hub::WsFrame;
use wisp_channels_api::testing::{Reply, ScriptWs, TestHub, quiet};
use wisp_channels_api::{ChannelHub, Transport};

/// A snowflake made at 2023-11-14 22:13:20 (the hub's now).
const ID: &str = "1173000000000000000";

fn hub(senders: &[&str]) -> Arc<TestHub> {
    let h = TestHub { reply: Some("✓ On it.".into()), start_as: Some("t1".into()), ..TestHub::default() }.with_cfg("discord", json!({ "enabled": true, "token": "bot-tok", "senders": senders, "linkCode": "ab12cd" }));
    *h.now.lock().unwrap() = wisp_discord_core::message::snowflake_ms(ID).unwrap();
    h.net.replies.lock().unwrap().extend([
        Reply::json("/gateway/bot", json!({ "url": "wss://gateway.discord.gg" })),
        Reply::json("/threads", json!({ "id": "TH1" })),
        Reply::json("/messages", json!({ "id": "M2" })),
    ]);
    Arc::new(h)
}

fn hello() -> WsFrame {
    ScriptWs::text(&json!({ "op": 10, "d": { "heartbeat_interval": 41_250 } }))
}

fn ready() -> WsFrame {
    ScriptWs::text(&json!({ "op": 0, "t": "READY", "s": 1, "d": { "session_id": "S1", "resume_gateway_url": "wss://resume.discord.gg", "user": { "id": "900", "username": "wisp" }, "application": { "id": "777" } } }))
}

fn message(d: &Value) -> WsFrame {
    ScriptWs::text(&json!({ "op": 0, "t": "MESSAGE_CREATE", "s": 2, "d": d }))
}

fn start(h: &Arc<TestHub>) -> Arc<dyn Transport> {
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    wisp_discord::transport(dyn_hub)
}

#[tokio::test]
async fn a_linked_persons_mention_is_answered_in_a_thread_made_on_it() {
    let h = hub(&["U1"]);
    h.ws.push(vec![
        hello(),
        ready(),
        message(&json!({ "id": ID, "channel_id": "C1", "guild_id": "G1", "type": 0, "author": { "id": "U1" }, "mentions": [{ "id": "900" }], "content": "<@900> in api fix the login" })),
        WsFrame::Close(4004, String::new()),
    ]);
    let t = start(&h);
    t.start(h.stop.clone()).await;
    let sent = h.ws.sent.lock().unwrap().clone();
    assert!(sent[0].contains(r#""op":2"#) && sent[0].contains(r#""intents":4609"#), "identify, no privileged intent: {sent:?}");
    assert!(h.ws.urls.lock().unwrap()[0].ends_with("/?v=10&encoding=json"));
    assert!(h.last_mark("discord").unwrap().error.unwrap().contains("refused the token"), "4004: it won't come back");
    assert_eq!(h.ws.urls.lock().unwrap().len(), 1);
    h.run_spawned().await;
    let c = h.conversed();
    assert_eq!((c.len(), c[0].text.as_str(), c[0].sender.as_str()), (1, "in api fix the login", "U1"));
    let threads = h.net.sent("/threads");
    assert_eq!(threads.len(), 1, "a thread on the asking message");
    let posts: Vec<_> = h.net.requests.lock().unwrap().iter().filter(|r| r.url.ends_with("/channels/TH1/messages")).map(|r| serde_json::from_slice::<Value>(&r.body).unwrap()).collect();
    assert_eq!((posts[0]["content"].as_str(), posts[0]["allowed_mentions"]["parse"].clone()), (Some("✓ On it."), json!([])), "said in the thread, pinging nobody");
    assert_eq!(h.remote_of("t1").unwrap()["discord"]["channel"], "TH1");
    assert_eq!(h.remote_of("t1").unwrap()["discord"]["thread"], true);
    assert!(t.extra("invite").await.unwrap()["url"].as_str().unwrap().contains("client_id=777&"), "the invite names the application Discord said");
}

#[tokio::test]
async fn a_stranger_is_told_once_and_link_with_the_code_lets_them_in() {
    let h = hub(&[]);
    let dm = |id: &str, text: &str| message(&json!({ "id": id, "channel_id": "D9", "type": 0, "author": { "id": "U9" }, "content": text }));
    h.ws.push(vec![hello(), ready(), dm(ID, "fix it"), dm("1173000000000000001", "link nope"), dm("1173000000000000002", "link ab12cd"), WsFrame::Close(4004, String::new())]);
    let t = start(&h);
    t.start(h.stop.clone()).await;
    h.run_spawned().await;
    assert_eq!(h.conversed().len(), 0, "nothing a stranger says is read");
    let said: Vec<String> = h.net.sent("/channels/D9/messages").iter().map(|b| b["content"].as_str().unwrap_or_default().to_owned()).collect();
    assert!(said[0].contains("only answers people linked"), "{said:?}");
    assert!(said.iter().any(|s| s.contains("doesn’t match")), "{said:?}");
    assert!(said.last().unwrap().contains("Linked to wisp"), "{said:?}");
    assert_eq!(h.cfg("discord")["senders"], json!(["U9"]));
}

#[tokio::test]
async fn a_dropped_connection_resumes_and_a_quiet_one_ends_at_its_unanswered_beat() {
    let h = hub(&["U1"]);
    h.ws.push(vec![hello(), ready(), WsFrame::Close(1006, String::new())]);
    h.ws.push(vec![hello(), quiet()]);
    h.ws.push(vec![WsFrame::Close(4014, String::new())]);
    let t = start(&h);
    t.start(h.stop.clone()).await;
    let urls = h.ws.urls.lock().unwrap().clone();
    assert!(urls[1].starts_with("wss://resume.discord.gg"), "the session's own URL: {urls:?}");
    let sent = h.ws.sent.lock().unwrap().clone();
    assert!(sent.iter().any(|s| s.contains(r#""op":6"#) && s.contains(r#""session_id":"S1""#)), "a resume: {sent:?}");
    assert!(sent.iter().filter(|s| s.contains(r#""op":1"#)).count() >= 1, "a beat on the quiet one");
    assert_eq!(urls.len(), 3, "the quiet one ended and another dialled");
    assert!(h.last_mark("discord").unwrap().error.unwrap().contains("intents"));
}
