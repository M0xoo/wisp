//! `/wisp`, its autocomplete and the report's buttons, end to end on the channels api's test hub (v1
//! test/discord.test.js's interaction cases): on a computer down the gateway and answered by REST; on a cloud wisp
//! posted to the grid, signed by Discord and checked by the box.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::many_single_char_names, clippy::format_collect)]

use std::sync::Arc;

use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{Value, json};
use wisp_channels_api::hub::{BoxGrid, WsFrame};
use wisp_channels_api::testing::{Reply, ScriptWs, TestHub};
use wisp_channels_api::views::{Action, ActionKind, Msg, SessionView};
use wisp_channels_api::{ChannelHub, InboundOpts, MemberView, ProjectView, Transport};

const ID: &str = "1173000000000000000";

fn hub(senders: &[&str], on_box: bool, key: &str) -> Arc<TestHub> {
    let mut h = TestHub { reply: Some("✓ On it.".into()), start_as: Some("t1".into()), ..TestHub::default() }.with_cfg("discord", json!({ "enabled": true, "token": "bot-tok", "senders": senders, "linkCode": "ab12cd", "publicKey": key, "appId": "777" }));
    if on_box {
        h.on_box = Some(BoxGrid { grid: "https://grid.test".into(), auth: "Box pia s".into() });
    }
    *h.now.lock().unwrap() = wisp_discord_core::message::snowflake_ms(ID).unwrap();
    let p = Arc::get_mut(&mut h.phone).unwrap();
    p.ctx.projects = vec![ProjectView { id: "p1".into(), name: "web".into(), path: "/w".into(), ..ProjectView::default() }, ProjectView { id: "p2".into(), name: "api".into(), path: "/a".into(), ..ProjectView::default() }];
    p.ctx.crew = vec![MemberView { id: "m1".into(), name: "Ada Lovelace".into(), agent: "claude".into(), ..MemberView::default() }];
    h.net.replies.lock().unwrap().extend([
        Reply::json("/gateway/bot", json!({ "url": "wss://gateway.discord.gg" })),
        Reply::json("/commands", json!([])),
        Reply::json("/callback", json!({})),
        Reply::json("@original", json!({ "id": "M9" })),
        Reply::json("/threads", json!({ "id": "TH1" })),
        Reply::json("/messages", json!({ "id": "M2" })),
    ]);
    Arc::new(h)
}

fn frames(d: &Value) -> Vec<WsFrame> {
    vec![
        ScriptWs::text(&json!({ "op": 10, "d": { "heartbeat_interval": 41_250 } })),
        ScriptWs::text(&json!({ "op": 0, "t": "READY", "s": 1, "d": { "session_id": "S1", "resume_gateway_url": "wss://r", "user": { "id": "900", "username": "wisp" }, "application": { "id": "777" } } })),
        ScriptWs::text(&json!({ "op": 0, "t": "INTERACTION_CREATE", "s": 2, "d": d })),
        WsFrame::Close(4004, String::new()),
    ]
}

fn start(h: &Arc<TestHub>) -> Arc<dyn Transport> {
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    wisp_discord::transport(dyn_hub)
}

fn calls(h: &TestHub) -> Vec<(String, String, Value)> {
    h.net.requests.lock().unwrap().iter().map(|r| (r.method.clone(), r.url.clone(), serde_json::from_slice(&r.body).unwrap_or(Value::Null))).collect()
}

fn slash(user: &str, guild: bool) -> Value {
    let mut d = json!({ "id": ID, "type": 2, "token": "TOK", "application_id": "777", "channel_id": "C1", "member": { "user": { "id": user } }, "data": { "name": "wisp", "options": [{ "name": "prompt", "value": "fix the login" }, { "name": "project", "value": "web" }] } });
    if guild {
        d["guild_id"] = json!("G1");
    }
    d
}

#[tokio::test]
async fn slash_wisp_is_registered_answered_at_once_and_runs_in_a_thread_on_its_reply() {
    let h = hub(&["U1"], false, "");
    h.ws.push(frames(&slash("U1", true)));
    let t = start(&h);
    t.start(h.stop.clone()).await;
    h.run_spawned().await;
    let c = calls(&h);
    let put = c.iter().find(|(m, u, _)| m == "PUT" && u.ends_with("/applications/777/commands")).expect("registered");
    assert_eq!(put.2[0]["name"], "wisp");
    let cb = c.iter().find(|(_, u, _)| u.contains(&format!("/interactions/{ID}/TOK/callback"))).unwrap();
    assert_eq!(cb.2["type"], 5, "thinking, within Discord's three seconds");
    let conversed = h.conversed();
    assert_eq!((conversed.len(), conversed[0].text.as_str(), conversed[0].sender.as_str()), (1, "in web: fix the login", "U1"));
    let edit = c.iter().find(|(m, u, _)| m == "PATCH" && u.ends_with("/webhooks/777/TOK/messages/@original")).unwrap();
    assert_eq!(edit.2["content"], "▶ On it.", "the reply is edited, then the thread made on it");
    assert!(c.iter().any(|(_, u, _)| u.ends_with("/channels/C1/messages/M9/threads")));
    let posted = c.iter().find(|(m, u, _)| m == "POST" && u.ends_with("/channels/TH1/messages")).unwrap();
    assert_eq!((posted.2["content"].as_str(), posted.2["allowed_mentions"]["parse"].clone()), (Some("✓ On it."), json!([])));
    assert_eq!(h.remote_of("t1").unwrap()["discord"]["channel"], "TH1");
}

#[tokio::test]
async fn a_strangers_slash_in_a_server_gets_silence_and_their_keystroke_an_empty_list() {
    let h = hub(&["U1"], false, "");
    h.ws.push(frames(&slash("U9", true)));
    let t = start(&h);
    t.start(h.stop.clone()).await;
    h.run_spawned().await;
    assert_eq!(h.conversed().len(), 0);
    assert!(calls(&h).iter().all(|(_, u, _)| !u.contains("/callback")), "no answer at all: Discord shows them, only them, that it failed");
    // autocomplete: names only for someone linked
    let key = |user: &str, typed: &str| json!({ "id": "1173000000000000001", "type": 4, "token": "K", "channel_id": "C1", "guild_id": "G1", "member": { "user": { "id": user } }, "data": { "name": "wisp", "options": [{ "name": "project", "value": typed, "focused": true }] } });
    for (user, want) in [("U9", json!([])), ("U1", json!([{ "name": "web", "value": "web" }]))] {
        let h = hub(&["U1"], false, "");
        h.ws.push(frames(&key(user, "WE")));
        let t = start(&h);
        t.start(h.stop.clone()).await;
        h.run_spawned().await;
        let cb = calls(&h).into_iter().find(|(_, u, _)| u.contains("/callback")).unwrap();
        assert_eq!((cb.2["type"].clone(), cb.2["data"]["choices"].clone()), (json!(8), want), "{user}");
    }
}

#[tokio::test]
async fn a_reports_choices_are_buttons_and_a_signed_press_answers_the_task() {
    let h = hub(&["U1"], false, "");
    h.remotes.lock().unwrap().insert("t1".into(), [("discord".to_owned(), json!({ "channel": "TH1", "thread": true, "ids": [] }))].into_iter().collect());
    h.started.lock().unwrap().insert("t1".into(), ("discord".into(), None));
    let t = start(&h);
    let sv = SessionView { id: "t1".into(), ..SessionView::default() };
    let msg = Msg { title: "Pick one".into(), text: "Which way?".into(), actions: vec![Action { kind: ActionKind::Answer, label: "Left".into(), reference: "q1".into(), index: 0 }, Action { kind: ActionKind::Done, label: "Done".into(), reference: String::new(), index: 0 }] };
    t.publish(&msg, Some(&sv)).await.unwrap();
    let post = calls(&h).into_iter().find(|(_, u, _)| u.ends_with("/channels/TH1/messages")).unwrap().2;
    let button = &post["components"][0]["components"][0];
    assert_eq!((button["label"].as_str(), post["components"][0]["components"].as_array().unwrap().len()), (Some("Left"), 1), "{post}");
    assert!(!post["content"].as_str().unwrap().contains("Choices:"), "the buttons say them");
    // pressed by someone linked
    let press = |id: &str, custom: &str| json!({ "id": id, "type": 3, "token": "P", "application_id": "777", "channel_id": "TH1", "guild_id": "G1", "member": { "user": { "id": "U1" } }, "data": { "custom_id": custom } });
    let good = button["custom_id"].as_str().unwrap().to_owned();
    h.ws.push(frames(&press("1173000000000000005", &good)));
    t.start(h.stop.clone()).await;
    h.run_spawned().await;
    let c = calls(&h);
    assert!(c.iter().any(|(_, u, b)| u.contains("/interactions/1173000000000000005/P/callback") && b["type"] == 6), "seen at once");
    assert!(c.iter().any(|(m, u, b)| m == "PATCH" && u.ends_with("/webhooks/777/P/messages/@original") && b["components"] == json!([])), "the buttons go");
    let said: Vec<String> = c.iter().filter(|(m, u, _)| m == "POST" && u.ends_with("/channels/TH1/messages")).map(|(_, _, b)| b["content"].as_str().unwrap_or_default().to_owned()).collect();
    assert_eq!(said.last().map(String::as_str), Some("✓ Done."), "{said:?}");
    // a forged one does nothing but say so
    let forged = good.replace(":0:", ":1:");
    h.ws.push(frames(&press("1173000000000000006", &forged)));
    t.start(h.stop.clone()).await;
    h.run_spawned().await;
    let said: Vec<String> = calls(&h).iter().filter(|(m, u, _)| m == "POST" && u.ends_with("/channels/TH1/messages")).map(|(_, _, b)| b["content"].as_str().unwrap_or_default().to_owned()).collect();
    assert!(said.last().unwrap().contains("doesn’t work any more"), "{said:?}");
}

fn signed(k: &SigningKey, body: &[u8]) -> Vec<(String, String)> {
    let mut msg = b"1700000000".to_vec();
    msg.extend_from_slice(body);
    let sig: String = k.sign(&msg).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    vec![("x-signature-ed25519".into(), sig), ("x-signature-timestamp".into(), "1700000000".into())]
}

#[tokio::test]
async fn on_a_cloud_wisp_a_held_interaction_is_checked_by_its_signature_and_runs_once() {
    let k = SigningKey::from_bytes(&[5u8; 32]);
    let public: String = k.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    let h = hub(&["U1"], true, &public);
    let t = start(&h);
    let ping = br#"{"id":"1173000000000000000","type":1}"#;
    let r = t.inbound(ping, &signed(&k, ping), InboundOpts::default()).await;
    assert_eq!((r.status, r.body["type"].clone()), (200, json!(1)), "the Portal's check");
    let bad = t.inbound(ping, &signed(&SigningKey::from_bytes(&[6u8; 32]), ping), InboundOpts::default()).await;
    assert_eq!(bad.status, 401, "another key's signature");
    let body = slash("U1", false).to_string().into_bytes();
    let r = t.inbound(&body, &signed(&k, &body), InboundOpts::default()).await;
    assert_eq!(r.status, 200);
    r.after.unwrap().await;
    let c = calls(&h);
    assert!(c.iter().all(|(_, u, _)| !u.contains("/callback")), "the grid answered it: nothing answers again");
    assert_eq!(h.conversed().len(), 1);
    assert!(c.iter().any(|(m, u, b)| m == "PATCH" && u.ends_with("/webhooks/777/TOK/messages/@original") && b["content"] == "✓ On it."), "its thinking reply is what's edited");
    let again = t.inbound(&body, &signed(&k, &body), InboundOpts::default()).await;
    assert_eq!((again.status, again.body["duplicate"].clone(), again.after.is_none()), (200, json!(true), true), "a repeat runs nothing");
    let stranger = slash("U9", true).to_string().replace(ID, "1173000000000000009").into_bytes();
    let r = t.inbound(&stranger, &signed(&k, &stranger), InboundOpts::default()).await;
    assert_eq!(r.status, 403, "so the grid stops paying for a stranger's wakes");
    // older than its token: dropped, and whoever's linked told
    *h.now.lock().unwrap() += 15 * 60_000;
    let late = slash("U1", false).to_string().replace(ID, "1173000000000000010").into_bytes();
    assert_eq!(t.inbound(&late, &signed(&k, &late), InboundOpts::default()).await.status, 410);
}
