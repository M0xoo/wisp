#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::inconsistent_digit_grouping,
    clippy::assert_is_empty
)] // tests may fail loudly
//! An event read down to a person's message, a click down to its signed button, and Slack's markup
//! gone before the grammar reads it (v1 test/channel-slack.test.js: "a stranger in a channel … bots
//! and edits too", "duplicates", "other interactive payloads are acked and ignored", "a value tampered
//! with answers nothing", "stripFormatting: Slack's markup").
mod common;

use serde_json::{Value, json};
use wisp_slack_core::event::{
    Button, Skip, button, click, link_code, message, strip_formatting, thread_key,
};

fn ev(e: Value) -> Value {
    json!({ "event_id": "Ev1", "event": e })
}

#[test]
fn a_mention_and_a_dm_are_messages_with_their_thread_and_ids() {
    let m = message(&ev(json!({ "type": "app_mention", "user": "U0ME", "text": "<@UBOT> hi", "channel": "C1", "ts": "1700000000.000100", "client_msg_id": "cm1" })), Some("UBOT")).unwrap();
    assert!(!m.dm);
    assert_eq!(m.root(), "1700000000.000100");
    assert_eq!(m.key(), "C1:1700000000.000100");
    assert_eq!(
        m.ids(),
        vec!["Ev1".to_owned(), "m:cm1".to_owned()],
        "one message as two events is one"
    );
    assert_eq!(m.at_s(), Some(1_700_000_000.0001));
    let d = message(&ev(json!({ "type": "message", "channel_type": "im", "user": "U0ME", "text": "x", "channel": "D1", "ts": "1.2", "thread_ts": "1.1" })), None).unwrap();
    assert!(d.dm);
    assert_eq!(
        d.key(),
        "D1:1.1",
        "a reply in a thread answers in that thread"
    );
}

#[test]
fn bots_edits_itself_and_channel_chatter_are_not_messages() {
    let me = Some("UBOT");
    let base = json!({ "type": "app_mention", "user": "U0ME", "channel": "C1", "ts": "1.1" });
    let with = |k: &str, v: Value| {
        let mut e = base.clone();
        e[k] = v;
        ev(e)
    };
    assert_eq!(message(&with("bot_id", json!("B9")), me), Err(Skip::Bot));
    assert_eq!(
        message(&with("user", json!("UBOT")), me),
        Err(Skip::Bot),
        "it would answer itself"
    );
    assert_eq!(message(&with("user", Value::Null), me), Err(Skip::Bot));
    assert_eq!(
        message(&with("subtype", json!("message_changed")), me),
        Err(Skip::Subtype)
    );
    assert_eq!(
        message(&with("subtype", json!("bot_message")), me),
        Err(Skip::Subtype)
    );
    assert!(
        message(&with("subtype", json!("file_share")), me).is_ok(),
        "a person's file is a message"
    );
    assert_eq!(
        message(
            &ev(json!({ "type": "message", "user": "U0ME", "channel": "C1", "ts": "1" })),
            me
        ),
        Err(Skip::Kind),
        "a channel message that doesn't mention it"
    );
    assert_eq!(message(&json!({}), me), Err(Skip::Kind));
    assert_eq!(
        thread_key(&ev(json!({ "channel": "C1", "ts": "2", "thread_ts": "1" }))).as_deref(),
        Some("C1:1")
    );
}

#[test]
fn link_codes_are_the_whole_message() {
    assert_eq!(link_code("link 123456"), Some(Some("123456")));
    assert_eq!(link_code("LINK  42"), Some(Some("42")));
    assert_eq!(link_code("link"), Some(None));
    assert_eq!(link_code("link 1 2"), None);
    assert_eq!(link_code("linked"), None);
    assert_eq!(link_code("lin"), None);
    assert_eq!(link_code("please link 1"), None);
}

fn payload(value: &str) -> Value {
    json!({
        "type": "block_actions", "user": { "id": "U0ME" }, "trigger_id": "tr1",
        "container": { "channel_id": "C1" },
        "message": { "ts": "5.5", "thread_ts": "5.0", "text": "Q?", "blocks": [{ "type": "section" }, { "type": "actions" }] },
        "actions": [{ "action_id": "wisp:0", "value": value, "action_ts": "1700000000.5" }]
    })
}

#[test]
fn a_click_on_wisps_button() {
    let c = click(&payload("{}")).unwrap();
    assert_eq!(
        (c.chat.as_str(), c.root.as_str(), c.message_ts.as_str()),
        ("C1", "5.0", "5.5")
    );
    assert_eq!(c.key(), "C1:5.0");
    assert_eq!(c.id.as_deref(), Some("tr1"));
    assert_eq!(c.blocks.len(), 2);
    for other in [
        json!({ "type": "view_submission" }),
        json!({ "type": "block_actions", "actions": [] }),
        json!({ "type": "block_actions", "actions": [{ "action_id": "someone-elses" }] }),
        Value::Null,
    ] {
        assert!(click(&other).is_none(), "{other}");
    }
    let mut no_msg = payload("{}");
    no_msg["message"] = Value::Null;
    assert!(
        click(&no_msg).is_none(),
        "an ephemeral message has no buttons of wisp's"
    );
}

#[test]
fn a_buttons_value_is_wisps_shape_or_nothing() {
    let real = json!({ "k": "a", "s": "S1", "r": "ask-1", "i": 0, "sig": "abc" }).to_string();
    assert_eq!(
        button(&real),
        Some(Button {
            k: "a".into(),
            s: "S1".into(),
            r: "ask-1".into(),
            i: 0,
            sig: "abc".into()
        })
    );
    for bad in [
        r#"{"k":"a","s":"S1","r":"x","i":"0","sig":"abc"}"#,
        r#"{"s":"S1","r":"x","i":1.5}"#,
        r#"{"s":1,"r":"x","i":0}"#,
        "a:nope",
        "null",
        "",
        r#"{"s":"S","r":"x","i":-1}"#,
    ] {
        assert_eq!(button(bad), None, "{bad}");
    }
}

#[test]
fn strip_formatting_reads_slacks_markup_as_words() {
    let bot = Some("UBOT");
    assert_eq!(
        strip_formatting("<@UBOT> in api: fix it", bot),
        "in api: fix it"
    );
    assert_eq!(strip_formatting("<@UBOT|wisp>, hi <@UBOT>", bot), "hi");
    assert_eq!(
        strip_formatting("see <https://example.com|example.com>", None),
        "see example.com"
    );
    assert_eq!(
        strip_formatting("see <https://example.com>", None),
        "see https://example.com"
    );
    assert_eq!(
        strip_formatting("<https://evil.example|click>", None),
        "click (https://evil.example)"
    );
    assert_eq!(strip_formatting("<mailto:a@b.c|a@b.c>", None), "a@b.c");
    assert_eq!(
        strip_formatting("in <#C1|general> and <#C2>", None),
        "in #general and #C2"
    );
    assert_eq!(
        strip_formatting("<!here> <!subteam^S1|@devs>", None),
        "@here @devs"
    );
    assert_eq!(
        strip_formatting("a &lt;b&gt; &amp;amp; <@U9>", bot),
        "a <b> &amp; <@U9>"
    );
    assert_eq!(strip_formatting("\u{200b} x\u{a0}y\r\nz ", None), "x y\nz");
    assert_eq!(strip_formatting("1 < 2 and <x", None), "1 < 2 and <x");
}

#[test]
fn property_strip_formatting_never_leaves_the_bot_or_a_zero_width() {
    let mut r = common::Rng::new(0xbeef);
    let parts = [
        "<@UBOT>",
        "<@UBOT|wisp>",
        "<",
        ">",
        "|",
        "#",
        "!",
        "here",
        "http://",
        "x",
        " ",
        ",",
        ":",
        "&amp;",
        "&lt;",
        "\u{200b}",
        "é",
        "😀",
        "\n",
    ];
    for _ in 0..5_000 {
        let len = r.below(25);
        let s = r.string(&parts, len);
        let out = strip_formatting(&s, Some("UBOT"));
        assert!(!out.contains('\u{200b}'), "{s:?} → {out:?}");
        assert_eq!(out.trim(), out);
        if !s.contains('&') {
            assert!(!out.contains("<@UBOT>"), "{s:?} → {out:?}");
        }
    }
}
