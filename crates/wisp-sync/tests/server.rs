//! SyncServer rules, one by one, on a scripted clock (the TS reference's server.test.ts).
#![allow(clippy::unwrap_used, clippy::missing_panics_doc)]

mod support;

use serde_json::{Value, json};
use support::{FakeStore, Op, TestChange, ch, make_server, title, topic};
use wisp_protocol::Notice;
use wisp_sync::sse::{SseParser, decode_frame};
use wisp_sync::{CloseReason, CommandOutcome, ConnId, ConnectQuery, Input, Output, SnapshotAnswer, SyncOptions, SyncServer};

type Out = Output<String>;

const C1: ConnId = ConnId(1);
const C2: ConnId = ConnId(2);

fn q(pairs: &[(&str, &str)]) -> ConnectQuery {
    let mut q = ConnectQuery::default();
    for (k, v) in pairs {
        let v = Some((*v).to_owned());
        match *k {
            "proto_min" => q.proto_min = v,
            "proto_max" => q.proto_max = v,
            "client_id" => q.client_id = v,
            "epoch" => q.epoch = v,
            "cursor" => q.cursor = v,
            "last_event_id" => q.last_event_id = v,
            "topics" => q.topics = v,
            "fresh" => q.fresh = v,
            "passive" => q.passive = v,
            other => panic!("{other}"),
        }
    }
    // a v2 client always sends its window; tests that leave it out mean the default one
    if q.proto_max.is_none() && q.client_id.is_none() && q.topics.is_none() && q.fresh.is_none() {
        q.proto_max = Some("2".into());
    }
    q
}

fn sends(outs: &[Out]) -> Vec<(ConnId, &str, Option<u64>)> {
    outs.iter().filter_map(|o| if let Output::Send { conn, frame, id } = o { Some((*conn, frame.as_str(), *id)) } else { None }).collect()
}

/// Every message of every frame, decoded through the real SSE parser.
fn msgs(outs: &[Out]) -> Vec<Value> {
    let mut out = Vec::new();
    for (_, frame, _) in sends(outs) {
        for ev in SseParser::new().push(frame.as_bytes()) {
            if decode_frame(&ev).is_some() {
                out.extend(serde_json::from_str::<Vec<Value>>(&ev.data).unwrap());
            }
        }
    }
    out
}

fn kinds(outs: &[Out]) -> Vec<&'static str> {
    outs.iter()
        .map(|o| match o {
            Output::Send { .. } => "send",
            Output::SnapshotRequest { .. } => "snapshotRequest",
            Output::WindowRequest { .. } => "windowRequest",
            Output::Command { .. } => "command",
            Output::Activity { .. } => "activity",
            Output::Close { .. } => "close",
        })
        .collect()
}

fn requests(outs: &[Out]) -> Vec<(String, Option<u64>)> {
    outs.iter().filter_map(|o| if let Output::SnapshotRequest { topic, since, .. } = o { Some((topic.to_string(), *since)) } else { None }).collect()
}

fn ts(m: &[Value]) -> Vec<&str> {
    m.iter().map(|m| m["t"].as_str().unwrap()).collect()
}

/// A server with connections whose snapshots the store answers at once.
struct S {
    store: FakeStore,
    server: SyncServer<String>,
    now: u64,
    query: ConnectQuery,
}

impl S {
    fn new(query: ConnectQuery, f: impl FnOnce(&mut SyncOptions<String>)) -> Self {
        let mut store = FakeStore::default();
        store.commit(&[ch("list", "session", "s1", Op::Upsert(json!({"title": "one"})))], 0);
        let server = make_server(&store, f);
        Self { store, server, now: 1000, query }
    }

    fn run(&mut self, outs: Vec<Out>) -> Vec<Out> {
        let mut all = Vec::new();
        for o in outs {
            let req = if let Output::SnapshotRequest { conn, topic, since, req } = &o { Some((*conn, topic.clone(), *since, *req)) } else { None };
            all.push(o);
            if let Some((conn, topic, since, req)) = req {
                let (rows, deleted, full) = match since {
                    None => (self.store.snapshot(&topic), vec![], true),
                    Some(s) => {
                        let (r, d) = self.store.delta(&topic, s);
                        (r, d, false)
                    }
                };
                let a = SnapshotAnswer { conn, topic, req, seq: self.store.seq, rows, full, deleted, more: false };
                let more = self.server.handle(Input::SnapshotRows(a), self.now);
                all.extend(self.run(more));
            }
        }
        all
    }

    fn handle(&mut self, input: Input<String>) -> Vec<Out> {
        let outs = self.server.handle(input, self.now);
        self.run(outs)
    }

    fn connect(&mut self, conn: ConnId) -> Vec<Out> {
        let query = self.query.clone();
        self.connect_with(conn, query)
    }

    fn connect_with(&mut self, conn: ConnId, query: ConnectQuery) -> Vec<Out> {
        self.handle(Input::Connect { conn, caller: "me".into(), query })
    }

    fn commit(&mut self, changes: &[TestChange]) -> Vec<Out> {
        let rows = self.store.commit(changes, self.now);
        self.handle(Input::Committed { rows })
    }

    fn tick(&mut self, ms: u64) -> Vec<Out> {
        self.now += ms;
        self.handle(Input::Tick)
    }

    fn send(&mut self, conn: ConnId, message: Value) -> Vec<Out> {
        self.handle(Input::Message { conn, message })
    }

    fn drained(&mut self, conn: ConnId, bytes: usize) -> Vec<Out> {
        self.handle(Input::Drained { conn, buffered_bytes: bytes })
    }
}

#[test]
fn welcome_resumes_only_with_the_same_epoch_and_a_cursor_the_log_still_covers() {
    let cases: [(&[(&str, &str)], bool, Option<u64>); 6] = [
        (&[("epoch", "E1"), ("cursor", "1"), ("topics", "list")], true, Some(1)),
        (&[("epoch", "E1"), ("cursor", "0"), ("topics", "list")], true, Some(0)), // oldest_seq is 0: everything after 0 is kept
        (&[("epoch", "E0"), ("cursor", "1"), ("topics", "list")], false, None),   // a restore made a new epoch
        (&[("epoch", "E1"), ("topics", "list")], false, None),                    // no cursor
        (&[("epoch", "E1"), ("cursor", "9"), ("topics", "list")], false, None),   // from the future: not this log
        (&[("epoch", "E1"), ("last_event_id", "1"), ("topics", "list")], true, Some(1)), // the browser's own reconnect
    ];
    for (pairs, resume, since) in cases {
        let mut s = S::new(q(pairs), |_| {});
        let outs = s.connect(C1);
        assert_eq!(msgs(&outs)[0]["resume"], json!(resume), "{pairs:?}");
        // resume asks for the delta since the cursor; otherwise the whole topic
        assert_eq!(requests(&outs), vec![("list".to_owned(), since)], "{pairs:?}");
    }
    let mut s = S::new(q(&[("epoch", "E1"), ("cursor", "0"), ("topics", "list")]), |o| o.oldest_seq = 1);
    assert_eq!(msgs(&s.connect(C1))[0]["resume"], json!(false), "retention passed the cursor");
}

#[test]
fn welcome_carries_the_peer_and_a_client_outside_the_window_is_told_and_closed() {
    let mut s = S::new(q(&[("fresh", "list")]), |_| {});
    let w = msgs(&s.connect(C1))[0].clone();
    assert_eq!((w["epoch"].clone(), w["head_seq"].clone(), w["oldest_seq"].clone(), w["proto"].clone(), w["peer"]["peer"].clone()), (json!("E1"), json!(1), json!(0), json!(2), json!("laptop")));
    let old = s.connect_with(C2, q(&[("proto_min", "1"), ("proto_max", "1"), ("fresh", "list")]));
    assert_eq!(msgs(&old)[0]["t"], "welcome");
    assert_eq!(old.iter().filter(|o| matches!(o, Output::Close { reason: CloseReason::Incompatible, .. })).count(), 1);
    assert!(requests(&old).is_empty());
}

#[test]
fn the_welcome_goes_before_the_snapshot_requests_of_the_same_connect() {
    let s = S::new(q(&[("fresh", "list,machines")]), |_| {});
    let mut server = s.server;
    let outs = server.handle(Input::Connect { conn: C1, caller: "me".into(), query: s.query }, 0);
    assert_eq!(kinds(&outs), vec!["send", "snapshotRequest", "snapshotRequest", "activity"]);
    assert_eq!(ts(&msgs(&outs)), vec!["welcome"]);
    // answered at once, the snapshot goes in the next frame, not held back by the welcome's flush
    let a = SnapshotAnswer { conn: C1, topic: topic("list"), req: 1, seq: 1, rows: vec![], full: true, deleted: vec![], more: false };
    assert_eq!(ts(&msgs(&server.handle(Input::SnapshotRows(a), 0))), vec!["snapshot"]);
}

#[test]
fn the_first_change_after_quiet_goes_at_once_the_rest_coalesce_into_one_frame_per_50_ms() {
    let mut s = S::new(q(&[("fresh", "list")]), |_| {});
    s.connect(C1);
    s.tick(100);
    assert_eq!(sends(&s.commit(&[title("a")])).len(), 1, "idle: at once");
    let mut frames = 0;
    for i in 0..100 {
        frames += sends(&s.commit(&[title(&format!("t{i}"))])).len(); // within the same ms
    }
    assert_eq!(frames, 0, "held for the flush");
    let out = s.tick(50);
    assert_eq!(sends(&out).len(), 1);
    let patch = msgs(&out).into_iter().find(|m| m["t"] == "patch").unwrap();
    assert_eq!(patch["ops"], json!([{"topic": "list", "e": "session", "id": "s1", "op": "patch", "ops": [{"op": "replace", "path": "/title", "value": "t99"}]}]), "100 changes, one op");
}

#[test]
fn streaming_10_entities_for_1_s_is_bounded_by_the_flush_rate_not_the_change_rate() {
    let mut s = S::new(q(&[("fresh", "list,session:x")]), |_| {});
    s.connect(C1);
    let (mut frames, mut changes) = (0, 0);
    for ms in (0..1000).step_by(5) {
        for e in 0..10 {
            frames += sends(&s.commit(&[ch("session:x", "turn", &format!("t{e}"), Op::Append(vec![json!(ms)]))])).len();
            changes += 1;
        }
        frames += sends(&s.tick(5)).len();
    }
    assert_eq!(changes, 2000);
    assert!(frames <= 21, "{frames} frames");
    assert!(s.server.stats().frames <= 22);
}

#[test]
fn priority_acks_then_the_session_then_the_list_then_the_rest_and_the_watermark_never_passes_what_is_queued() {
    let mut s = S::new(q(&[("fresh", "list,session:a,machines")]), |o| o.high_water_bytes = 500);
    s.connect(C1);
    s.drained(C1, 0);
    s.tick(100); // the snapshots go
    s.drained(C1, 0);
    s.tick(100);
    let big = json!("x".repeat(150));
    let rows = s.store.commit(&[ch("machines", "m", "m1", Op::Upsert(big.clone())), ch("list", "session", "s9", Op::Upsert(big.clone())), ch("session:a", "turn", "t1", Op::Upsert(big))], s.now);
    let machines = rows[0].seq;
    let out = s.server.handle(Input::Committed { rows }, s.now);
    // the budget fits two: the session first, then the list; machines waits
    let patch = msgs(&out).into_iter().find(|m| m["t"] == "patch").unwrap();
    let topics: Vec<&str> = patch["ops"].as_array().unwrap().iter().map(|o| o["topic"].as_str().unwrap()).collect();
    assert_eq!(topics, vec!["session:a", "list"]);
    assert_eq!(sends(&out)[0].2, Some(machines - 1), "a resume from this frame must still get the queued machines row");
    s.server.handle(Input::CommandResult { conn: C1, mid: "m1".into(), outcome: CommandOutcome::Ok { seq: 1, result: None } }, s.now);
    s.drained(C1, 0);
    let next = s.tick(50);
    assert_eq!(ts(&msgs(&next)), vec!["ack", "patch"]);
    assert_eq!(sends(&next)[0].2, Some(s.store.seq));
}

#[test]
fn an_ack_waits_until_the_effects_it_reports_have_been_sent() {
    let mut s = S::new(q(&[("fresh", "list")]), |o| o.high_water_bytes = 300);
    s.connect(C1);
    s.drained(C1, 0);
    s.tick(100);
    let rows = s.store.commit(&[ch("list", "session", "s2", Op::Upsert(json!("y".repeat(400)))), title("t")], s.now);
    let first = s.server.handle(Input::Committed { rows }, s.now); // the budget takes the first row only
    assert_eq!(ts(&msgs(&first)), vec!["patch"]);
    assert_eq!(sends(&first)[0].2, Some(s.store.seq - 1));
    let seq = s.store.seq;
    s.server.handle(Input::CommandResult { conn: C1, mid: "m1".into(), outcome: CommandOutcome::Ok { seq, result: Some(json!({"id": "s2"})) } }, s.now);
    s.drained(C1, 0);
    assert_eq!(msgs(&s.tick(50))[0], json!({"t": "ack", "mid": "m1", "seq": seq, "result": {"id": "s2"}}));
    // a reject has nothing to wait for
    s.server.handle(Input::CommandResult { conn: C1, mid: "m2".into(), outcome: CommandOutcome::Err { code: "vetoed".into(), message: "over budget".into() } }, s.now);
    assert_eq!(msgs(&s.tick(50)), vec![json!({"t": "reject", "mid": "m2", "code": "vetoed", "message": "over budget"})]);
}

#[test]
fn backpressure_drops_a_topic_with_resync_past_the_high_water_mark_and_it_recovers_from_its_since() {
    let mut s = S::new(q(&[("fresh", "list,session:a")]), |o| o.high_water_bytes = 1000);
    s.connect(C1);
    s.tick(100);
    let before = s.store.seq;
    s.drained(C1, 5000); // the phone stopped reading
    for i in 0..20 {
        s.commit(&[ch("session:a", "turn", &format!("t{i}"), Op::Upsert(json!(i))), title(&format!("x{i}"))]);
    }
    let shed = s.tick(50);
    let mut resynced: Vec<String> = msgs(&shed).iter().filter(|m| m["t"] == "resync").map(|m| m["topic"].as_str().unwrap().to_owned()).collect();
    resynced.sort();
    assert_eq!(resynced, vec!["list", "session:a"]);
    assert!(!msgs(&shed).iter().any(|m| m["t"] == "patch"), "nothing heavy goes into a full socket");
    assert_eq!(sends(&shed)[0].2, Some(before), "the cursor stays before what was dropped");
    assert_eq!(s.server.stats().resyncs, 2);
    // while dropped, new changes for the topic are not queued
    s.commit(&[title("late")]);
    // the client resubscribes from its cursor; the socket is still full, so the delta waits
    assert!(requests(&s.send(C1, json!({"t": "sub", "topic": "list", "since": before}))).is_empty());
    let recover = s.drained(C1, 0);
    assert_eq!(requests(&recover), vec![("list".to_owned(), Some(before))]);
    let patch = msgs(&s.tick(50)).into_iter().find(|m| m["t"] == "patch").unwrap();
    assert_eq!(patch["ops"], json!([{"topic": "list", "e": "session", "id": "s1", "op": "upsert", "v": {"title": "late"}}]));
}

#[test]
fn changes_during_a_snapshot_are_held_and_sent_after_it_without_the_ones_it_already_has() {
    let mut store = FakeStore::default();
    let mut server = make_server(&store, |_| {});
    let out = server.handle(Input::Connect { conn: C1, caller: "me".into(), query: q(&[("fresh", "list")]) }, 0);
    let Some(Output::SnapshotRequest { req, .. }) = out.iter().find(|o| matches!(o, Output::SnapshotRequest { .. })).cloned() else { panic!() };
    let r1 = store.commit(&[title("a")], 0);
    server.handle(Input::Committed { rows: r1 }, 100); // read by the snapshot below
    let (snap_at, snap_rows) = (store.seq, store.snapshot(&topic("list")));
    let r2 = store.commit(&[title("b")], 0);
    server.handle(Input::Committed { rows: r2 }, 100); // after the snapshot's read
    // an answer to an older request is ignored
    let stale = SnapshotAnswer { conn: C1, topic: topic("list"), req: req + 7, seq: 0, rows: vec![], full: true, deleted: vec![], more: false };
    assert!(server.handle(Input::SnapshotRows(stale), 100).is_empty());
    let a = SnapshotAnswer { conn: C1, topic: topic("list"), req, seq: snap_at, rows: snap_rows, full: true, deleted: vec![], more: false };
    let sent = msgs(&server.handle(Input::SnapshotRows(a), 200));
    assert_eq!(ts(&sent), vec!["snapshot", "patch"]);
    assert_eq!(sent[1]["ops"][0]["ops"], json!([{"op": "replace", "path": "/title", "value": "b"}]));
}

#[test]
fn snapshot_pages_go_in_order_and_the_cursor_holds_for_a_resumed_topic_until_the_last_page() {
    let store = FakeStore::default();
    let mut server = make_server(&store, |o| o.head_seq = 5);
    let out = server.handle(Input::Connect { conn: C1, caller: "me".into(), query: q(&[("epoch", "E1"), ("cursor", "3"), ("topics", "list")]) }, 0);
    assert_eq!(requests(&out), vec![("list".to_owned(), Some(3))]);
    let page = |n: u32, more: bool| SnapshotAnswer { conn: C1, topic: topic("list"), req: 1, seq: 5, rows: vec![wisp_protocol::Row { e: "x".into(), id: n.to_string(), v: json!(n) }], full: true, deleted: vec![], more };
    let p1 = server.handle(Input::SnapshotRows(page(1, true)), 100);
    assert_eq!(sends(&p1)[0].2, Some(3), "not past the since until the whole topic is there");
    assert!(server.handle(Input::SnapshotRows(page(2, false)), 100).is_empty(), "within the flush interval: it waits for the tick");
    let p2 = server.handle(Input::Tick, 150);
    assert_eq!(msgs(&p2).iter().map(|m| m.get("more").is_some()).collect::<Vec<_>>(), vec![false]);
    assert_eq!(sends(&p2)[0].2, Some(5));
}

#[test]
fn a_client_that_reconnects_replaces_its_old_stream() {
    let mut s = S::new(q(&[("client_id", "phone"), ("fresh", "list")]), |_| {});
    s.connect(C1);
    let out = s.connect(C2);
    assert_eq!(out.iter().filter(|o| **o == Output::Close { conn: C1, reason: CloseReason::Replaced }).count(), 1);
    assert_eq!(s.server.conn_of("phone"), Some(C2));
}

#[test]
fn denied_topics_get_a_notice_and_no_data() {
    let store = FakeStore::default();
    let mut server = make_server(&store, |o| o.can_read = Box::new(|caller: &String, t: &wisp_protocol::Topic| caller == "owner" || !t.is_session()));
    let mut store = store;
    let out = server.handle(Input::Connect { conn: C1, caller: "agent".into(), query: q(&[("fresh", "list,session:secret,bogus topic")]) }, 0);
    assert_eq!(requests(&out), vec![("list".to_owned(), None)]);
    let notices: Vec<Value> = msgs(&out).into_iter().filter(|m| m["t"] == "notice").collect();
    assert_eq!(notices, vec![json!({"t": "notice", "kind": "denied", "data": {"topic": "bogus topic", "code": "invalid"}}), json!({"t": "notice", "kind": "denied", "data": {"topic": "session:secret", "code": "forbidden"}})]);
    let win = server.handle(Input::Message { conn: C1, message: json!({"t": "window", "req": "w1", "topic": "session:secret", "before_seq": 9, "limit": 50}) }, 100);
    assert!(!kinds(&win).contains(&"windowRequest"));
    let rows = store.commit(&[ch("session:secret", "turn", "t", Op::Upsert(json!(1)))], 0);
    assert!(server.handle(Input::Committed { rows }, 200).is_empty());
}

#[test]
fn passive_subscriptions_never_count_as_use_and_one_active_sub_does() {
    let mut s = S::new(q(&[("fresh", "list,machines"), ("passive", "1")]), |_| {});
    let out = s.connect(C1);
    assert!(!kinds(&out).contains(&"activity"));
    assert_eq!(s.server.active_count(), 0);
    let sub = s.send(C1, json!({"t": "sub", "topic": "session:a"}));
    assert_eq!(sub.iter().filter(|o| **o == Output::Activity { conn: C1, active: true }).count(), 1);
    assert_eq!(s.server.active_count(), 1);
    // the same sub again, passive: only the flag changes (no second snapshot)
    let again = s.send(C1, json!({"t": "sub", "topic": "session:a", "passive": true}));
    assert_eq!(kinds(&again), vec!["activity"]);
    assert_eq!(s.server.active_count(), 0);
    let mut mixed = S::new(q(&[("fresh", "list,machines"), ("passive", "machines")]), |_| {});
    mixed.connect(C1);
    assert_eq!(mixed.server.active_count(), 1);
}

#[test]
fn window_paging_goes_to_the_host_and_its_rows_come_back_on_the_stream() {
    let mut s = S::new(q(&[("fresh", "session:a")]), |_| {});
    s.connect(C1);
    let req = s.send(C1, json!({"t": "window", "req": "w1", "topic": "session:a", "before_seq": 900, "limit": 5000}));
    assert_eq!(req, vec![Output::WindowRequest { conn: C1, req: "w1".into(), topic: topic("session:a"), before_seq: 900, limit: 1000 }]);
    s.tick(100);
    let rows = vec![wisp_protocol::Row { e: "event".into(), id: "1".into(), v: json!("old") }];
    let out = s.handle(Input::WindowRows { conn: C1, req: "w1".into(), rows, done: true });
    assert_eq!(msgs(&out), vec![json!({"t": "rows", "req": "w1", "rows": [{"e": "event", "id": "1", "v": "old"}], "done": true})]);
}

#[test]
fn mutate_goes_to_the_host_as_a_command_with_the_caller_and_malformed_messages_are_dropped() {
    let mut s = S::new(q(&[("fresh", "list")]), |_| {});
    s.connect(C1);
    let out = s.send(C1, json!({"t": "mutate", "mid": "m1", "cmd": "session.followUp", "args": {"text": "hi"}, "base_seq": 3}));
    assert_eq!(out, vec![Output::Command { conn: C1, caller: "me".into(), mid: "m1".into(), cmd: "session.followUp".into(), args: json!({"text": "hi"}), base_seq: Some(3) }]);
    let long = "x".repeat(300);
    for bad in [json!(null), json!("x"), json!({"t": "mutate"}), json!({"t": "sub", "topic": "nope"}), json!({"t": "sub", "topic": "list", "since": -1}), json!({"t": "boom"}), json!({"t": "mutate", "mid": long, "cmd": "c"})] {
        assert!(s.send(C1, bad.clone()).is_empty(), "{bad}");
    }
}

#[test]
fn heartbeats_keep_a_quiet_stream_open_and_next_wake_at_says_when() {
    let mut s = S::new(q(&[("fresh", "list")]), |o| o.heartbeat_ms = 15_000);
    s.connect(C1);
    assert_eq!(s.server.next_wake_at(), Some(s.now + 15_000));
    assert!(sends(&s.tick(14_000)).is_empty());
    let hb = s.tick(1000);
    assert_eq!(sends(&hb), vec![(C1, ": hb\n\n", None)]);
    s.commit(&[title("z")]);
    s.server.handle(Input::Close { conn: C1 }, s.now);
    assert_eq!(s.server.next_wake_at(), None);
}

#[test]
fn notices_go_to_every_stream_or_only_to_those_on_the_topic() {
    let mut s = S::new(q(&[("client_id", "a"), ("fresh", "list")]), |_| {});
    s.connect(C1);
    s.connect_with(C2, q(&[("client_id", "b"), ("fresh", "machines")]));
    s.tick(100);
    let notice = Notice { t: wisp_protocol::tag::Notice, kind: "toast".into(), data: json!("hi") };
    let out = s.handle(Input::Notice { notice: notice.clone(), topic: Some(topic("machines")) });
    assert_eq!(sends(&out).iter().map(|f| f.0).collect::<Vec<_>>(), vec![C2]);
    let all = s.handle(Input::Notice { notice, topic: None });
    assert_eq!(sends(&all).iter().map(|f| f.0).collect::<Vec<_>>(), vec![C1, C2]);
}

#[test]
fn v1_clients_get_v1_named_events_and_relays_neither_count_nor_get_machine_events() {
    let mut s = S::new(q(&[("fresh", "list")]), |o| o.v1_ping_ms = 25_000);
    s.connect(C1);
    let v1 = s.connect_with(C2, ConnectQuery::default());
    assert_eq!(v1, vec![Output::Send { conn: C2, frame: "event: hello\ndata: {}\n\n".into(), id: None }, Output::Activity { conn: C2, active: true }]);
    let relay = s.connect_with(ConnId(3), ConnectQuery { relay: true, ..ConnectQuery::default() });
    assert_eq!(kinds(&relay), vec!["send"], "a relaying wisp doesn't keep a box awake");
    assert_eq!(s.server.active_count(), 2);
    let ev = s.handle(Input::Legacy { event: wisp_sync::V1Event::Summary, data: json!({"id": "s1", "title": "a\nb"}), from_machine: false });
    assert_eq!(sends(&ev), vec![(C2, "event: summary\ndata: {\"id\":\"s1\",\"title\":\"a\\nb\"}\n\n", None), (ConnId(3), "event: summary\ndata: {\"id\":\"s1\",\"title\":\"a\\nb\"}\n\n", None)]);
    let relayed = s.handle(Input::Legacy { event: wisp_sync::V1Event::Turn, data: json!({}), from_machine: true });
    assert_eq!(sends(&relayed).iter().map(|f| f.0).collect::<Vec<_>>(), vec![C2], "not sent back to a relay: two wisps that list each other would loop it");
    // v2 changes never reach a v1 stream, and v1 streams get v1's ping
    assert!(sends(&s.commit(&[title("x")])).iter().all(|f| f.0 == C1));
    let pings = s.tick(25_000);
    let pinged: Vec<ConnId> = sends(&pings).iter().filter(|f| f.1 == "event: ping\ndata: {}\n\n").map(|f| f.0).collect();
    assert_eq!(pinged, vec![C2, ConnId(3)]);
}
