//! `SyncClient` rules, one by one: packages/sync/test/client.test.ts, case for case.

use serde_json::{Value, json};

use super::*;

fn msg(v: Value) -> ServerMessage {
    serde_json::from_value(v).unwrap()
}

#[allow(clippy::needless_pass_by_value)]
fn welcome(over: Value) -> ServerMessage {
    let mut w = json!({ "t": "welcome", "epoch": "E1", "head_seq": 10, "oldest_seq": 0, "resume": false, "proto": 2,
        "peer": { "peer": "laptop", "name": "laptop", "build": "test", "version": "2.0.0", "proto_min": 2, "proto_max": 2, "plugins": [] } });
    if let (Some(w), Some(o)) = (w.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            w.insert(k.clone(), v.clone());
        }
    }
    msg(w)
}

fn sent(outs: &[Output]) -> Vec<Value> {
    outs.iter().filter_map(|o| if let Output::Send(m) = o { Some(serde_json::to_value(m).unwrap()) } else { None }).collect()
}

fn kinds(outs: &[Output]) -> Vec<&'static str> {
    outs.iter()
        .map(|o| match o {
            Output::Request { .. } => "request",
            Output::Send(_) => "send",
            Output::Reset { .. } => "reset",
            Output::Snapshot { .. } => "snapshot",
            Output::EntityOps { .. } => "entityOps",
            Output::Rows { .. } => "rows",
            Output::Ack { .. } => "ack",
            Output::Reject { .. } => "reject",
            Output::NeedResubscribe { .. } => "needResubscribe",
            Output::Denied { .. } => "denied",
            Output::Notice(_) => "notice",
            Output::State { .. } => "state",
            Output::Retry { .. } => "retry",
        })
        .collect()
}

fn frame(id: u64, messages: Vec<ServerMessage>) -> Input {
    Input::Frame { id: Some(id), messages }
}

fn live(c: &mut SyncClient, w: Value, id: u64) -> Vec<Output> {
    c.handle(Input::Open, 0);
    c.handle(frame(id, vec![welcome(w)]), 0)
}

fn client() -> SyncClient {
    SyncClient::new(Options::new("laptop", "tab1", "b1"))
}

fn with(f: impl FnOnce(&mut Options)) -> SyncClient {
    let mut o = Options::new("laptop", "tab1", "b1");
    f(&mut o);
    SyncClient::new(o)
}

fn sub(t: &str) -> Input {
    Input::Subscribe { topic: t.into(), passive: false }
}
fn passive(t: &str) -> Input {
    Input::Subscribe { topic: t.into(), passive: true }
}
fn unsub(t: &str) -> Input {
    Input::Unsubscribe { topic: t.into(), passive: false }
}

fn saved_e1() -> Saved {
    Saved { epoch: Some("E1".into()), cursor: Some(42), synced: vec!["list".into()], ..Saved::default() }
}

#[test]
fn two_views_of_one_session_are_one_sub_the_last_one_out_unsubscribes() {
    let mut c = client();
    live(&mut c, json!({}), 10);
    assert_eq!(sent(&c.handle(sub("session:a"), 0)), [json!({ "t": "sub", "topic": "session:a" })]);
    assert_eq!(sent(&c.handle(sub("session:a"), 0)), Vec::<Value>::new());
    assert_eq!(sent(&c.handle(unsub("session:a"), 0)), Vec::<Value>::new());
    assert_eq!(sent(&c.handle(unsub("session:a"), 0)), [json!({ "t": "unsub", "topic": "session:a" })]);
}

#[test]
fn passive_refs_the_first_active_view_makes_it_count() {
    let mut c = client();
    live(&mut c, json!({}), 10);
    assert_eq!(sent(&c.handle(passive("machines"), 0)), [json!({ "t": "sub", "topic": "machines", "passive": true })]);
    assert_eq!(sent(&c.handle(sub("machines"), 0)), [json!({ "t": "sub", "topic": "machines" })]);
    assert_eq!(sent(&c.handle(unsub("machines"), 0)), [json!({ "t": "sub", "topic": "machines", "passive": true })]);
}

#[test]
fn the_hello_carries_the_window_cursor_resumed_fresh_and_passive_topics() {
    let mut c = with(|o| o.saved = Some(saved_e1()));
    c.handle(sub("list"), 0);
    c.handle(sub("session:a"), 0);
    c.handle(passive("machines"), 0);
    let outs = c.handle(Input::Open, 0);
    let Some(Output::Request { params }) = outs.iter().find(|o| matches!(o, Output::Request { .. })) else { panic!("no request") };
    let want: BTreeMap<String, String> = [("proto_min", "2"), ("proto_max", "2"), ("client_id", "tab1"), ("build", "b1"), ("epoch", "E1"), ("cursor", "42"), ("topics", "list"), ("fresh", "session:a,machines"), ("passive", "machines")]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    assert_eq!(params, &want);
    // a resumed welcome keeps the rows; the cursor moves to the frame's id
    let outs = c.handle(frame(42, vec![welcome(json!({ "resume": true }))]), 0);
    assert!(!kinds(&outs).contains(&"reset"));
    assert_eq!(c.state(), State::Live);
    assert_eq!(c.save(), saved_e1());
}

#[test]
fn resume_false_or_a_new_epoch_drops_the_caches_for_this_peer() {
    let mut c = with(|o| o.saved = Some(saved_e1()));
    c.handle(sub("list"), 0);
    assert!(kinds(&live(&mut c, json!({ "resume": false }), 10)).contains(&"reset"));
    let mut d = with(|o| o.saved = Some(saved_e1()));
    d.handle(sub("list"), 0);
    assert!(kinds(&live(&mut d, json!({ "resume": true, "epoch": "E2" }), 10)).contains(&"reset"), "a resume from another epoch is not trusted");
    assert_eq!(d.epoch(), Some("E2"));
}

#[test]
fn pending_mutations_go_again_after_welcome_with_the_same_mid_until_ack_or_reject() {
    let mut c = client();
    c.handle(Input::Mutate { mid: "m1".into(), cmd: "session.followUp".into(), args: json!({ "text": "hi" }), base_seq: None }, 0);
    assert_eq!(sent(&live(&mut c, json!({}), 10)), [json!({ "t": "mutate", "mid": "m1", "cmd": "session.followUp", "args": { "text": "hi" } })]);
    c.handle(Input::Lost, 0);
    let again = sent(&live(&mut c, json!({}), 10));
    assert_eq!(again.iter().map(|m| m["mid"].clone()).collect::<Vec<_>>(), [json!("m1")], "a flaky tunnel: same key, never run twice");
    // the ack comes after the frame's ops, so base has the effect before the optimistic patch goes
    c.handle(sub("list"), 0);
    c.handle(frame(11, vec![msg(json!({ "t": "snapshot", "topic": "list", "seq": 11, "rows": [] }))]), 0);
    let outs = c.handle(frame(12, vec![msg(json!({ "t": "ack", "mid": "m1", "seq": 12 })), msg(json!({ "t": "patch", "seq": 12, "ops": [{ "topic": "list", "e": "s", "id": "1", "op": "upsert", "v": 1 }] }))]), 0);
    assert_eq!(kinds(&outs), ["entityOps", "ack"]);
    assert_eq!(c.save().pending, Vec::new());
    c.handle(Input::Mutate { mid: "m2".into(), cmd: "x".into(), args: Value::Null, base_seq: None }, 0);
    let rej = c.handle(frame(12, vec![msg(json!({ "t": "reject", "mid": "m2", "code": "forbidden", "message": "no" }))]), 0);
    assert_eq!(rej.into_iter().filter(|o| matches!(o, Output::Reject { .. })).collect::<Vec<_>>(), [Output::Reject { mid: "m2".into(), code: "forbidden".into(), message: "no".into() }]);
}

#[test]
fn version_window_outside_it_the_older_side_must_update() {
    let mut old = with(|o| (o.proto_min, o.proto_max) = (1, 1));
    let outs = live(&mut old, json!({}), 10);
    assert_eq!(outs.into_iter().filter(|o| matches!(o, Output::State { state: State::Incompatible, .. })).collect::<Vec<_>>(), [Output::State { state: State::Incompatible, update: Some(Update::Client) }]);
    assert_eq!(old.state(), State::Incompatible);
    assert_eq!(old.handle(Input::Lost, 0), Vec::new(), "no retry loop against a peer it cannot speak to");
    let mut ahead = with(|o| (o.proto_min, o.proto_max) = (5, 7));
    let outs = live(&mut ahead, json!({}), 10);
    assert_eq!(outs, [Output::State { state: State::Incompatible, update: Some(Update::Peer) }], "nothing else in the frame counts");
    assert_eq!(ahead.state(), State::Incompatible);
    // overlapping windows speak the highest both know
    let mut both = with(|o| (o.proto_min, o.proto_max) = (2, 4));
    let outs = live(&mut both, json!({}), 10);
    assert_eq!(outs.into_iter().filter(|o| matches!(o, Output::State { .. })).collect::<Vec<_>>(), [Output::State { state: State::Live, update: None }]);
}

#[test]
fn snapshot_pages_are_joined_a_page_at_another_seq_starts_over() {
    let mut c = client();
    live(&mut c, json!({}), 10);
    c.handle(sub("list"), 0);
    let page = |seq: u64, id: &str, more: bool| {
        let mut p = json!({ "t": "snapshot", "topic": "list", "seq": seq, "rows": [{ "e": "s", "id": id, "v": id }] });
        if more {
            p["more"] = json!(true);
        }
        msg(p)
    };
    assert_eq!(c.handle(frame(10, vec![page(10, "a", true)]), 0), Vec::new());
    // the server started the topic over at a later seq: the old pages are worthless
    let outs = c.handle(frame(12, vec![page(12, "b", true), page(12, "c", false)]), 0);
    let row = |id: &str| Row { e: "s".into(), id: id.into(), v: json!(id) };
    assert_eq!(outs, [Output::Snapshot { peer: "laptop".into(), topic: "list".into(), rows: vec![row("b"), row("c")] }]);
}

#[test]
fn ops_for_a_topic_still_waiting_for_its_snapshot_are_ignored() {
    let mut c = client();
    live(&mut c, json!({}), 10);
    c.handle(sub("list"), 0);
    let p = msg(json!({ "t": "patch", "seq": 11, "ops": [{ "topic": "list", "e": "s", "id": "1", "op": "patch", "ops": [] }] }));
    assert_eq!(c.handle(frame(11, vec![p]), 0), Vec::new());
}

#[test]
fn resync_a_synced_topic_resubscribes_from_the_cursor_one_never_synced_starts_fresh() {
    let mut c = client();
    live(&mut c, json!({}), 10);
    c.handle(sub("list"), 0);
    c.handle(sub("session:a"), 0);
    c.handle(frame(15, vec![msg(json!({ "t": "snapshot", "topic": "list", "seq": 15, "rows": [] }))]), 0);
    let outs = c.handle(frame(14, vec![msg(json!({ "t": "resync", "topic": "list" })), msg(json!({ "t": "resync", "topic": "session:a" }))]), 0);
    assert_eq!(kinds(&outs), ["needResubscribe", "send", "needResubscribe", "send"]);
    // the frame's id is the watermark, even when it is lower than the last one
    assert_eq!(sent(&outs), [json!({ "t": "sub", "topic": "list", "since": 14 }), json!({ "t": "sub", "topic": "session:a" })]);
    assert_eq!(c.cursor(), Some(14));
}

#[test]
fn denied_topics_are_reported_and_left_out_of_the_next_hello() {
    let mut c = client();
    c.handle(sub("session:secret"), 0);
    live(&mut c, json!({}), 10);
    let outs = c.handle(frame(10, vec![msg(json!({ "t": "notice", "kind": "denied", "data": { "topic": "session:secret", "code": "forbidden" } })), msg(json!({ "t": "notice", "kind": "toast", "data": "hi" }))]), 0);
    assert_eq!(kinds(&outs), ["denied", "notice"]);
    assert_eq!(outs[0], Output::Denied { topic: "session:secret".into(), code: "forbidden".into() });
    assert!(matches!(&outs[1], Output::Notice(n) if n.kind == "toast" && n.data == json!("hi")));
    c.handle(Input::Lost, 0);
    let outs = c.handle(Input::Open, 0);
    assert!(outs.iter().any(|o| matches!(o, Output::Request { params } if !params.contains_key("fresh"))));
}

#[test]
fn lost_retries_back_off_exponentially_to_a_cap_and_reset_after_a_welcome() {
    let mut c = with(|o| (o.retry_base_ms, o.retry_max_ms) = (500, 4000));
    c.handle(Input::Open, 0);
    let mut at = Vec::new();
    for _ in 0..6 {
        let r = c.handle(Input::Lost, 1000).into_iter().find_map(|o| if let Output::Retry { at } = o { Some(at - 1000) } else { None });
        at.push(r.unwrap_or(-1));
        c.handle(Input::Open, 1000);
    }
    assert_eq!(at, [500, 1000, 2000, 4000, 4000, 4000]);
    c.handle(frame(1, vec![welcome(json!({}))]), 0);
    assert!(c.handle(Input::Lost, 0).contains(&Output::Retry { at: 500 }));
}

#[test]
fn subs_and_unsubs_made_while_connecting_are_sent_after_the_welcome() {
    let mut c = client();
    c.handle(sub("list"), 0);
    c.handle(Input::Open, 0);
    c.handle(sub("session:a"), 0);
    c.handle(unsub("list"), 0);
    let outs = c.handle(frame(10, vec![welcome(json!({}))]), 0);
    assert_eq!(sent(&outs), [json!({ "t": "sub", "topic": "session:a" }), json!({ "t": "unsub", "topic": "list" })]);
}

#[test]
fn a_drifted_topic_starts_over_unsub_then_a_fresh_sub() {
    let mut c = client();
    live(&mut c, json!({}), 10);
    c.handle(sub("list"), 0);
    assert_eq!(sent(&c.handle(Input::Drifted { topic: "list".into() }, 0)), [json!({ "t": "unsub", "topic": "list" }), json!({ "t": "sub", "topic": "list" })]);
}

#[test]
fn a_topic_held_at_an_older_seq_resumes_from_it_after_the_welcome() {
    // the restart case: the store still holds session:a as of seq 30, the cursor is at 42
    let saved = Saved { held: vec![("session:a".into(), 30)], ..saved_e1() };
    let mut c = with(|o| o.saved = Some(saved));
    c.handle(sub("session:a"), 0);
    let outs = c.handle(Input::Open, 0);
    assert!(outs.iter().any(|o| matches!(o, Output::Request { params } if !params.contains_key("topics") && !params.contains_key("fresh"))));
    let outs = c.handle(frame(42, vec![welcome(json!({ "resume": true }))]), 0);
    assert_eq!(sent(&outs), [json!({ "t": "sub", "topic": "session:a", "since": 30 })]);
    // the store still holds `list` (not subscribed now) as of the cursor
    assert_eq!(c.save().held, [("list".to_owned(), 42)]);
}
