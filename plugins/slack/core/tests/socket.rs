#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::inconsistent_digit_grouping,
    clippy::assert_is_empty
)] // tests may fail loudly
//! Socket Mode: frames, acks, one connection's rules and the dialling loop (v1 test/channel-slack.test.js:
//! "every envelope is acked at once", "duplicates … each acked", "Slack's own disconnect", "a socket that
//! says nothing … is replaced", "the connection drops: wisp dials again").
mod common;

use serde_json::{Value, json};
use wisp_slack_core::socket::{Dial, End, Frame, HELLO_MS, Listen, Next, Step, ack, parse};
use wisp_slack_core::{BACKOFF_MAX_MS, SlackError, backoff_ms};

fn env(ty: &str, id: &str, payload: Value) -> String {
    json!({ "type": ty, "envelope_id": id, "payload": payload }).to_string()
}

#[test]
fn hello_then_an_event_acked_before_its_work() {
    let mut l = Listen::new(0, 10_000);
    assert_eq!(l.deadline(), Some(20_000), "two beats, under 30 s");
    assert_eq!(l.frame(r#"{"type":"hello"}"#), vec![Step::Hello]);
    assert_eq!(l.deadline(), None);
    let steps = l.frame(&env(
        "events_api",
        "e1",
        json!({ "event": { "type": "app_mention" } }),
    ));
    assert_eq!(steps[0], Step::Send(ack("e1")), "the ack is first, always");
    assert!(matches!(steps[1], Step::Event(_)));
    assert!(l.end().heard);
}

#[test]
fn every_kind_of_envelope_is_acked_and_only_two_are_work() {
    let mut l = Listen::new(0, 30_000);
    let s = l.frame(&env("slash_commands", "env-slash", json!({})));
    assert_eq!(s, vec![Step::Send(ack("env-slash"))]);
    let s = l.frame(&env("interactive", "i1", Value::Null));
    assert_eq!(s, vec![Step::Send(ack("i1")), Step::Click(Value::Null)]);
    let s = l.frame(r#"{"type":"interactive","envelope_id":"env-bare"}"#);
    assert_eq!(s[0], Step::Send(ack("env-bare")));
    assert_eq!(l.frame("not json"), vec![]);
    assert_eq!(l.frame("[1,2]"), vec![]);
    assert_eq!(
        l.frame(r#"{"type":"events_api"}"#),
        vec![Step::Event(Value::Null)],
        "no id: nothing to ack"
    );
}

#[test]
fn the_ack_is_the_id_and_nothing_else() {
    let a: Value = serde_json::from_str(&ack("x\"y")).unwrap_or_default();
    assert_eq!(a, json!({ "envelope_id": "x\"y" }));
}

#[test]
fn slacks_disconnect_a_refresh_is_now_a_reason_is_for_good() {
    let mut l = Listen::new(0, 30_000);
    l.frame(r#"{"type":"hello"}"#);
    assert_eq!(
        l.frame(r#"{"type":"disconnect","reason":"refresh_requested"}"#),
        vec![Step::Close]
    );
    let end = l.end();
    assert!(end.again && end.code.is_none() && !end.dropped());
    let mut d = Dial::default();
    assert_eq!(d.ended(&end, 20), Next::Now);

    let mut l = Listen::new(0, 30_000);
    l.frame(r#"{"type":"disconnect","reason":"link_disabled"}"#);
    let end = l.end();
    assert_eq!(end.code.as_deref(), Some("link_disabled"));
    match Dial::default().ended(&end, 20) {
        Next::Stop(line) => assert_eq!(
            line,
            "Slack: link_disabled. Check the tokens in wisp → Settings → Phone → Slack."
        ),
        n => panic!("{n:?}"),
    }
}

#[test]
fn no_hello_in_time_closes_it() {
    let l = Listen::new(1_000, 60_000);
    assert_eq!(
        l.deadline(),
        Some(1_000 + i64::try_from(HELLO_MS).unwrap_or(0))
    );
    assert_eq!(l.tick(30_999), None);
    assert_eq!(l.tick(31_000), Some("Slack never said hello."));
    let mut l = Listen::new(0, 60_000);
    l.frame(r#"{"type":"hello"}"#);
    assert_eq!(l.tick(1_000_000), None, "heard: nothing to wait on");
}

#[test]
fn a_drop_backs_off_doubling_and_a_hello_starts_the_count_over() {
    let mut d = Dial::default();
    let dropped = End::default();
    assert!(dropped.dropped());
    assert_eq!(d.ended(&dropped, 20), Next::Wait(20));
    assert_eq!(d.ended(&dropped, 20), Next::Wait(40));
    assert_eq!(d.ended(&dropped, 20), Next::Wait(80));
    let heard = End {
        heard: true,
        ..End::default()
    };
    assert_eq!(
        d.ended(&heard, 20),
        Next::Wait(20),
        "it got somewhere: the first failure again"
    );
    assert_eq!(backoff_ms(1_000, 40), BACKOFF_MAX_MS);
}

#[test]
fn failures_a_revoked_token_stops_a_429_waits_its_retry_after() {
    let mut d = Dial::default();
    assert!(
        matches!(d.failed(&SlackError::Api("token_revoked".into()), 20), Next::Stop(l) if l.ends_with("Settings → Phone → Slack."))
    );
    assert_eq!(
        d.failed(&SlackError::RateLimited { retry_after_s: 3 }, 20),
        Next::Wait(3_000)
    );
    assert_eq!(
        d.failed(&SlackError::Net("timed out".into()), 20),
        Next::Wait(40)
    );
    assert_eq!(
        d.failed(&SlackError::Api("internal_error".into()), 20),
        Next::Wait(80)
    );
}

#[test]
fn property_any_text_parses_without_panicking_and_ids_round_trip() {
    let mut r = common::Rng::new(0x51ac);
    let alphabet = [
        "{",
        "}",
        "\"",
        ":",
        ",",
        "type",
        "envelope_id",
        "hello",
        "payload",
        "a",
        "1",
        "[",
        "]",
        "\\",
        "é",
    ];
    for _ in 0..5_000 {
        let len = r.below(40);
        let _ = parse(&r.string(&alphabet, len));
    }
    for _ in 0..1_000 {
        let len = r.below(30) + 1;
        let id = r.string(&["a", "-", "1", "\"", "\\", "é", "😀", " "], len);
        let f = parse(&env("events_api", &id, json!({})));
        assert_eq!(f.envelope_id(), Some(id.as_str()));
        let back: Value = serde_json::from_str(&ack(&id)).unwrap_or_default();
        assert_eq!(back["envelope_id"], Value::String(id));
    }
}

#[test]
fn property_a_dial_never_waits_past_the_cap_or_less_than_its_base() {
    let mut r = common::Rng::new(7);
    for _ in 0..200 {
        let mut d = Dial::default();
        let base = 1 + r.below(10_000) as u64;
        for _ in 0..r.below(60) {
            let end = End {
                heard: r.below(4) == 0,
                again: r.below(5) == 0,
                code: None,
            };
            match d.ended(&end, base) {
                Next::Wait(ms) => assert!(ms >= base.min(BACKOFF_MAX_MS) && ms <= BACKOFF_MAX_MS),
                Next::Now => assert!(end.again),
                Next::Stop(_) => panic!("no code, no stop"),
            }
        }
    }
    assert!(matches!(parse(r#"{"type":"hello"}"#), Frame::Hello));
}
