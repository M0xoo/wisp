//! Email on a cloud box, end to end on the channels api's test hub (v1 test/email-channel.test.js): only a DMARC
//! pass from the one allowed sender gets in (a 403 and silence otherwise), a message starts a task and is answered
//! by a reply, a reply to that follows the same task with its own words only, a reply to nothing wisp knows starts
//! nothing, and a repeat isn't read twice.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_channels_api::hub::BoxGrid;
use wisp_channels_api::testing::TestHub;
use wisp_channels_api::transport::InboundOpts;
use wisp_channels_api::{ChannelHub, Transport};

fn hub() -> Arc<TestHub> {
    let h = TestHub {
        reply: Some("✓ On it.".into()),
        start_as: Some("t1".into()),
        on_box: Some(BoxGrid { grid: "https://grid".into(), auth: "a".into() }),
        ..TestHub::default()
    }
    .with_cfg("email", json!({ "enabled": true, "sender": "ada@example.com" }));
    *h.now.lock().unwrap() = 1_704_164_645_000;
    Arc::new(h)
}

fn heads(from: &str, dmarc: &str, id: &str) -> Vec<(String, String)> {
    vec![("x-wisp-mail-from".into(), from.into()), ("x-wisp-mail-dmarc".into(), dmarc.into()), ("x-wisp-mail-id".into(), id.into())]
}

async fn deliver(t: &Arc<dyn Transport>, m: &Value, h: Vec<(String, String)>) -> u16 {
    let r = t.inbound(m.to_string().as_bytes(), &h, InboundOpts { at_ms: 1_704_164_645_000, verified: true }).await;
    if let Some(after) = r.after {
        after.await;
    }
    r.status
}

#[tokio::test]
async fn a_message_from_you_starts_a_task_and_a_reply_follows_it_up() {
    let h = hub();
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_email::transport(dyn_hub);
    assert!(t.ready());
    let first = json!({ "subject": "in api: fix the login", "text": "it 500s\n\nSent from my iPhone", "date": "2024-01-02T03:04:00Z" });
    assert_eq!(deliver(&t, &first, heads("ada@example.com", "pass", "<m1@x>")).await, 200);
    let c = h.conversed();
    assert_eq!(
        (c[0].text.as_str(), c[0].session.as_deref()),
        ("in api: fix the login\n\nit 500s", None),
        "subject and own words, no signature"
    );
    let mailed = h.mailed.lock().unwrap().clone();
    assert_eq!((mailed[0].0.as_str(), mailed[0].1.as_str()), ("<m1@x>", "Re: in api: fix the login"));
    assert!(mailed[0].2.starts_with("↩ Reply above this line") && mailed[0].2.ends_with("✓ On it."));
    assert_eq!(h.remote_of("t1").unwrap()["email"]["ids"], json!(["<m1@x>", "<r1@wisp>"]));
    // your reply to wisp's: the same task, your own words only, never the subject
    let reply = json!({ "subject": "Re: in api: fix the login", "inReplyTo": "<r1@wisp>", "text": "also the signup\n\nOn Tue, wisp wrote:\n> ✓ On it.", "date": "2024-01-02T03:05:00Z" });
    assert_eq!(deliver(&t, &reply, heads("ada@example.com", "pass", "<m2@x>")).await, 200);
    let c = h.conversed();
    assert_eq!((c[1].text.as_str(), c[1].session.as_deref()), ("also the signup", Some("t1")));
    assert_eq!(deliver(&t, &reply, heads("ada@example.com", "pass", "<m2@x>")).await, 200);
    assert_eq!(h.conversed().len(), 2, "a repeat isn't read twice");
}

#[tokio::test]
async fn anyone_unproved_or_else_gets_a_403_and_a_stray_reply_starts_nothing() {
    let h = hub();
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_email::transport(dyn_hub);
    let m = json!({ "subject": "fix", "text": "x", "date": "2024-01-02T03:04:00Z" });
    assert_eq!(deliver(&t, &m, heads("ada@example.com", "fail", "<a>")).await, 403, "no DMARC pass");
    assert_eq!(deliver(&t, &m, heads("ada@example.com", "unproved", "<b>")).await, 403);
    assert_eq!(deliver(&t, &m, heads("eve@example.com", "pass", "<c>")).await, 403, "not the allowed sender");
    assert_eq!(deliver(&t, &json!({ "subject": "fix" }), heads("ada@example.com", "pass", "<d>")).await, 403, "no date");
    assert!(h.mailed.lock().unwrap().is_empty(), "silence for all of them");
    let stray = json!({ "subject": "Re: something", "inReplyTo": "<unknown>", "text": "yes", "date": "2024-01-02T03:04:00Z" });
    assert_eq!(deliver(&t, &stray, heads("ada@example.com", "pass", "<e>")).await, 200);
    assert_eq!(h.conversed().len(), 0, "nothing ran");
    assert!(h.mailed.lock().unwrap()[0].2.contains("can’t find the task this answers"));
}

/// An email's attachments reach the task it starts (round 17): each file the grid brought is kept as an upload
/// and goes with the task; one it couldn't bring is said before the answer.
#[tokio::test]
async fn an_emails_attachments_go_with_the_task_and_the_ones_left_out_are_said() {
    let h = hub();
    let dyn_hub: Arc<dyn ChannelHub> = h.clone();
    let t = wisp_email::transport(dyn_hub);
    let m = json!({ "subject": "in api: why does this fail", "text": "see the log", "date": "2024-01-02T03:04:00Z", "attachments": 2, "files": [{ "name": "build.log", "mime": "text/plain", "data": "ZXJyb3I=" }] });
    assert_eq!(deliver(&t, &m, heads("ada@example.com", "pass", "<m9@x>")).await, 200);
    let c = h.conversed();
    assert_eq!(c[0].attachments, vec![json!({ "id": "u1", "name": "build.log", "mime": "text/plain", "size": 5 })]);
    assert_eq!(h.phone.uploads.lock().unwrap()[0].2, b"error".to_vec());
    let mailed = h.mailed.lock().unwrap().clone();
    assert!(mailed[0].2.contains("1 attachment didn’t come along"), "{mailed:?}");
}
