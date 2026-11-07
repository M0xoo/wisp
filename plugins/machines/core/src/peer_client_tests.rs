//! `@wisp/sync`'s client rules (packages/sync/test/client.test.ts), one by one, on the Rust port.
use serde_json::{Value, json};
use wisp_protocol::ServerMessage;

use super::*;

fn t(s: &str) -> Topic {
    Topic::parse(s).unwrap_or_else(Topic::list)
}

fn msgs(v: Value) -> Vec<ServerMessage> {
    serde_json::from_value(v).unwrap_or_default()
}

fn welcome(over: &Value) -> Value {
    let mut w = json!({"t": "welcome", "epoch": "E1", "head_seq": 10, "oldest_seq": 0, "resume": false, "proto": 2, "peer": {"peer": "laptop", "name": "laptop", "build": "b", "version": "2.0.0", "proto_min": 2, "proto_max": 2, "plugins": []}});
    for (k, v) in over.as_object().into_iter().flatten() {
        if k == "peer" {
            for (pk, pv) in v.as_object().into_iter().flatten() {
                w["peer"][pk] = pv.clone();
            }
        } else {
            w[k] = v.clone();
        }
    }
    w
}

fn sent(outs: &[Out]) -> Vec<Value> {
    outs.iter().filter_map(|o| if let Out::Send(m) = o { serde_json::to_value(m).ok() } else { None }).collect()
}

fn kinds(outs: &[Out]) -> Vec<&'static str> {
    outs.iter()
        .map(|o| match o {
            Out::Request(_) => "request",
            Out::Send(_) => "send",
            Out::Reset => "reset",
            Out::Snapshot { .. } => "snapshot",
            Out::EntityOps(_) => "entityOps",
            Out::Rows { .. } => "rows",
            Out::Ack { .. } => "ack",
            Out::Reject { .. } => "reject",
            Out::NeedResubscribe(_) => "needResubscribe",
            Out::Denied { .. } => "denied",
            Out::Notice(_) => "notice",
            Out::State(..) => "state",
            Out::Retry { .. } => "retry",
        })
        .collect()
}

fn request(outs: &[Out]) -> Vec<(String, String)> {
    outs.iter().find_map(|o| if let Out::Request(p) = o { Some(p.clone()) } else { None }).unwrap_or_default()
}

fn client(saved: Option<Saved>) -> PeerClient {
    PeerClient::new(Opts::new("tab1", "b1"), saved)
}

fn live(c: &mut PeerClient, over: &Value, id: u64) -> Vec<Out> {
    c.open();
    c.frame(Some(id), msgs(json!([welcome(over)])))
}

fn saved_list() -> Saved {
    Saved { epoch: Some("E1".into()), cursor: Some(42), synced: vec![t("list")], ..Saved::default() }
}

#[test]
fn two_views_are_one_sub_and_the_last_one_out_unsubscribes() {
    let mut c = client(None);
    live(&mut c, &json!({}), 10);
    assert_eq!(sent(&c.subscribe(&t("session:a"), false)), [json!({"t": "sub", "topic": "session:a"})]);
    assert!(sent(&c.subscribe(&t("session:a"), false)).is_empty());
    assert!(sent(&c.unsubscribe(&t("session:a"), false)).is_empty());
    assert_eq!(sent(&c.unsubscribe(&t("session:a"), false)), [json!({"t": "unsub", "topic": "session:a"})]);
}

#[test]
fn a_passive_only_topic_is_a_passive_sub_until_an_active_view_needs_the_box() {
    let mut c = client(None);
    live(&mut c, &json!({}), 10);
    assert_eq!(sent(&c.subscribe(&t("machines"), true)), [json!({"t": "sub", "topic": "machines", "passive": true})]);
    assert_eq!(sent(&c.subscribe(&t("machines"), false)), [json!({"t": "sub", "topic": "machines"})]);
    assert_eq!(sent(&c.unsubscribe(&t("machines"), false)), [json!({"t": "sub", "topic": "machines", "passive": true})]);
}

#[test]
fn the_hello_carries_the_window_the_cursor_for_this_epoch_and_passive_topics() {
    let mut c = client(Some(saved_list()));
    c.subscribe(&t("list"), false);
    c.subscribe(&t("session:a"), false);
    c.subscribe(&t("machines"), true);
    let params = request(&c.open());
    let p: BTreeMap<&str, &str> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let want = [("proto_min", "2"), ("proto_max", "2"), ("client_id", "tab1"), ("build", "b1"), ("epoch", "E1"), ("cursor", "42"), ("topics", "list"), ("fresh", "machines,session:a"), ("passive", "machines")];
    assert_eq!(p, want.into_iter().collect());
    let outs = c.frame(Some(42), msgs(json!([welcome(&json!({"resume": true}))])));
    assert!(!kinds(&outs).contains(&"reset"), "a resumed welcome keeps the rows");
    assert_eq!(c.state(), State::Live);
    assert_eq!(c.save(), saved_list());
}

#[test]
fn a_new_epoch_or_resume_false_drops_the_peers_rows() {
    let mut c = client(Some(saved_list()));
    c.subscribe(&t("list"), false);
    assert!(kinds(&live(&mut c, &json!({"resume": false}), 10)).contains(&"reset"));
    let mut d = client(Some(saved_list()));
    d.subscribe(&t("list"), false);
    assert!(kinds(&live(&mut d, &json!({"resume": true, "epoch": "E2"}), 10)).contains(&"reset"), "a resume from another epoch is not trusted");
    assert_eq!(d.epoch(), Some("E2"));
}

#[test]
fn pending_commands_go_again_after_each_welcome_with_the_same_mid() {
    let mut c = client(None);
    c.mutate("m1", "session.followUp", json!({"text": "hi"}), None);
    assert_eq!(sent(&live(&mut c, &json!({}), 10)), [json!({"t": "mutate", "mid": "m1", "cmd": "session.followUp", "args": {"text": "hi"}})]);
    c.lost(0);
    let again = live(&mut c, &json!({}), 10);
    assert_eq!(sent(&again).iter().map(|m| m["mid"].clone()).collect::<Vec<_>>(), [json!("m1")], "a flaky tunnel: same key, never run twice");
    c.subscribe(&t("list"), false);
    c.frame(Some(11), msgs(json!([{"t": "snapshot", "topic": "list", "seq": 11, "rows": []}])));
    let outs = c.frame(Some(12), msgs(json!([{"t": "ack", "mid": "m1", "seq": 12}, {"t": "patch", "seq": 12, "ops": [{"topic": "list", "e": "s", "id": "1", "op": "upsert", "v": 1}]}])));
    assert_eq!(kinds(&outs), ["entityOps", "ack"], "the effect is in base before the optimistic patch goes");
    assert!(c.save().pending.is_empty());
    c.mutate("m2", "x", Value::Null, None);
    let rej = c.frame(Some(12), msgs(json!([{"t": "reject", "mid": "m2", "code": "forbidden", "message": "no"}])));
    assert_eq!(rej, [Out::Reject { mid: "m2".into(), code: "forbidden".into(), message: "no".into() }]);
    // a duplicate ack (the far side answers a resend it had already run) settles nothing twice
    assert!(c.frame(Some(12), msgs(json!([{"t": "ack", "mid": "m1", "seq": 12}]))).is_empty());
}

#[test]
fn pending_commands_survive_a_restart() {
    let mut c = client(None);
    c.mutate("m1", "session.followUp", json!({"text": "hi"}), None);
    let mut d = client(Some(c.save()));
    assert_eq!(d.pending(), 1);
    assert_eq!(sent(&live(&mut d, &json!({}), 10))[0]["mid"], "m1");
}

#[test]
fn outside_the_version_window_the_older_side_must_update() {
    let mut old = PeerClient::new(Opts { proto_min: 1, proto_max: 1, ..Opts::new("tab1", "b1") }, None);
    let outs = live(&mut old, &json!({}), 10);
    assert!(outs.contains(&Out::State(State::Incompatible, Some(Update::Client))));
    assert!(old.lost(0).is_empty(), "no retry loop against a peer it cannot speak to");
    let mut ahead = PeerClient::new(Opts { proto_min: 5, proto_max: 7, ..Opts::new("tab1", "b1") }, None);
    let outs = live(&mut ahead, &json!({}), 10);
    assert_eq!(outs, [Out::State(State::Incompatible, Some(Update::Peer))], "nothing else in the frame counts");
    let mut ok = PeerClient::new(Opts { proto_min: 2, proto_max: 4, ..Opts::new("tab1", "b1") }, None);
    let outs = live(&mut ok, &json!({}), 10);
    assert!(outs.contains(&Out::State(State::Live, None)));
}

#[test]
fn snapshot_pages_are_joined_and_a_page_at_another_seq_starts_over() {
    let mut c = client(None);
    live(&mut c, &json!({}), 10);
    c.subscribe(&t("list"), false);
    let page = |seq: u64, id: &str, more: bool| json!({"t": "snapshot", "topic": "list", "seq": seq, "rows": [{"e": "s", "id": id, "v": id}], "more": more});
    assert!(c.frame(Some(10), msgs(json!([page(10, "a", true)]))).is_empty());
    let outs = c.frame(Some(12), msgs(json!([page(12, "b", true), page(12, "c", false)])));
    let rows = |ids: &[&str]| ids.iter().map(|i| Row { e: "s".into(), id: (*i).into(), v: json!(i) }).collect::<Vec<_>>();
    assert_eq!(outs, [Out::Snapshot { topic: t("list"), rows: rows(&["b", "c"]) }]);
}

#[test]
fn ops_for_a_topic_waiting_for_its_snapshot_are_ignored() {
    let mut c = client(None);
    live(&mut c, &json!({}), 10);
    c.subscribe(&t("list"), false);
    assert!(c.frame(Some(11), msgs(json!([{"t": "patch", "seq": 11, "ops": [{"topic": "list", "e": "s", "id": "1", "op": "patch", "ops": []}]}]))).is_empty());
}

#[test]
fn a_resync_resubscribes_from_the_cursor_and_a_topic_never_synced_starts_fresh() {
    let mut c = client(None);
    live(&mut c, &json!({}), 10);
    c.subscribe(&t("list"), false);
    c.subscribe(&t("session:a"), false);
    c.frame(Some(15), msgs(json!([{"t": "snapshot", "topic": "list", "seq": 15, "rows": []}])));
    let outs = c.frame(Some(14), msgs(json!([{"t": "resync", "topic": "list"}, {"t": "resync", "topic": "session:a"}])));
    assert_eq!(kinds(&outs), ["needResubscribe", "send", "needResubscribe", "send"]);
    assert_eq!(sent(&outs), [json!({"t": "sub", "topic": "list", "since": 14}), json!({"t": "sub", "topic": "session:a"})]);
    assert_eq!(c.cursor(), Some(14), "the frame's id is the watermark, even when lower");
}

#[test]
fn denied_topics_are_reported_and_left_out_of_the_next_hello() {
    let mut c = client(None);
    c.subscribe(&t("session:secret"), false);
    live(&mut c, &json!({}), 10);
    let outs = c.frame(Some(10), msgs(json!([{"t": "notice", "kind": "denied", "data": {"topic": "session:secret", "code": "forbidden"}}, {"t": "notice", "kind": "toast", "data": "hi"}])));
    assert_eq!(kinds(&outs), ["denied", "notice"]);
    c.lost(0);
    let p = request(&c.open());
    assert!(!p.is_empty());
    assert!(!p.iter().any(|(k, _)| k == "fresh"));
}

#[test]
fn retries_back_off_to_a_cap_and_start_over_after_a_welcome() {
    let mut c = PeerClient::new(Opts { retry_base_ms: 500, retry_max_ms: 4000, ..Opts::new("tab1", "b1") }, None);
    c.open();
    let mut at = Vec::new();
    for _ in 0..6 {
        let outs = c.lost(1000);
        at.push(outs.iter().find_map(|o| if let Out::Retry { at } = o { Some(at - 1000) } else { None }).unwrap_or(-1));
        c.open();
    }
    assert_eq!(at, [500, 1000, 2000, 4000, 4000, 4000]);
    c.frame(Some(1), msgs(json!([welcome(&json!({}))])));
    assert!(c.lost(0).contains(&Out::Retry { at: 500 }));
}

#[test]
fn subs_made_while_connecting_go_after_the_welcome() {
    let mut c = client(None);
    c.subscribe(&t("list"), false);
    c.open();
    c.subscribe(&t("session:a"), false);
    c.unsubscribe(&t("list"), false);
    let outs = c.frame(Some(10), msgs(json!([welcome(&json!({}))])));
    assert_eq!(sent(&outs), [json!({"t": "sub", "topic": "session:a"}), json!({"t": "unsub", "topic": "list"})]);
}

#[test]
fn a_drifted_topic_starts_over() {
    let mut c = client(None);
    live(&mut c, &json!({}), 10);
    c.subscribe(&t("list"), false);
    assert_eq!(sent(&c.drifted(&t("list"))), [json!({"t": "unsub", "topic": "list"}), json!({"t": "sub", "topic": "list"})]);
}

#[test]
fn frames_decode_only_sync_events() {
    let (id, m) = decode_frame("sync", Some("7"), r#"[{"t":"resync","topic":"list"},{"t":"bogus"}]"#).unwrap_or_default();
    assert_eq!((id, m.len()), (Some(7), 1));
    assert!(decode_frame("summary", None, "{}").is_none());
    assert!(decode_frame("sync", None, "{}").is_none());
}
