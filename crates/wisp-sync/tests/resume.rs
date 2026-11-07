//! Resuming and starting a drifted topic over, end to end: server, SSE framing and parser, and the
//! client model (the TS reference's resume.test.ts). The two end-to-end cases failed on the TS
//! server, which sent a snapshot before the welcome of the same connect; they are this crate's spec.
// tests may panic, and their helpers trade pedantry for reading like the TS twins
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::missing_panics_doc,
    clippy::assert_is_empty,
    clippy::doc_markdown,
    clippy::type_complexity,
    clippy::range_plus_one,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::collapsible_if,
    clippy::semicolon_if_nothing_returned
)]

mod support;

use serde_json::json;
use support::client::{Out, Saved, SyncClient};
use support::{
    FakeStore, Op, Rng, Sim, SimClient, SimOpts, ch, key, make_server, peer, topic, view,
};
use wisp_protocol::{ClientMessage, ServerMessage, Welcome, tag};

fn sent(outs: &[Out]) -> Vec<ClientMessage> {
    outs.iter()
        .filter_map(|o| {
            if let Out::Send(m) = o {
                Some(m.clone())
            } else {
                None
            }
        })
        .collect()
}

fn welcome(epoch: &str, head: u64, resume: bool) -> ServerMessage {
    ServerMessage::Welcome(Welcome {
        t: tag::Welcome,
        epoch: epoch.into(),
        head_seq: head,
        oldest_seq: 0,
        resume,
        proto: 2,
        peer: peer(),
    })
}

fn sub(t: &str, since: Option<u64>) -> ClientMessage {
    ClientMessage::Sub(wisp_protocol::Sub {
        t: tag::Sub,
        topic: topic(t),
        since,
        passive: None,
    })
}

#[test]
fn the_model_resumes_a_topic_subscribed_during_the_hello_when_the_store_holds_it() {
    let saved = Saved {
        epoch: Some("E1".into()),
        cursor: Some(42),
        synced: vec![topic("list"), topic("session:a")],
        ..Saved::default()
    };
    let mut c = SyncClient::new("tab", Some(saved));
    c.subscribe(&topic("list"), false);
    c.open();
    c.subscribe(&topic("session:a"), false); // the view mounted a tick after the open
    c.subscribe(&topic("session:b"), false); // never held: it can only start fresh
    let outs = c.frame(Some(42), vec![welcome("E1", 50, true)]);
    assert_eq!(
        sent(&outs),
        vec![sub("session:a", Some(42)), sub("session:b", None)]
    );
    let mut fresh = SyncClient::new(
        "tab",
        Some(Saved {
            epoch: Some("E1".into()),
            cursor: Some(42),
            synced: vec![topic("session:a")],
            ..Saved::default()
        }),
    );
    fresh.open();
    fresh.subscribe(&topic("session:a"), false);
    assert_eq!(
        sent(&fresh.frame(Some(60), vec![welcome("E2", 60, false)])),
        vec![sub("session:a", None)],
        "without a resume it starts fresh"
    );
}

#[test]
fn end_to_end_a_restored_client_that_subscribes_after_open_takes_a_delta_not_the_whole_topic() {
    let mut store = FakeStore::default();
    let rows: Vec<_> = (0..50)
        .map(|i| {
            ch(
                "session:a",
                "event",
                &format!("e{i}"),
                Op::Upsert(json!({"text": format!("step {i}")})),
            )
        })
        .collect();
    store.commit(&rows, 0);
    let server = make_server(&store, |_| {});
    let mut sim = Sim::new(
        store,
        server,
        vec![SimClient::new("phone", None)],
        Rng::new(1),
        SimOpts::default(),
    );
    // a phone that saw everything up to now, then restarted (rows and cursor from IndexedDB)
    sim.subscribe(0, &topic("session:a"), false);
    sim.open(0);
    sim.tick(100);
    assert_eq!(
        view(&sim.clients[0].map, &topic("session:a")).len(),
        50,
        "the first snapshot landed after the welcome"
    );
    let saved = sim.clients[0].client.save();
    sim.lose(0);
    sim.commit(&[ch(
        "session:a",
        "event",
        "e3",
        Op::Set(json!({"text": "edited"})),
    )]);
    let map = std::mem::take(&mut sim.clients[0].map);
    let cursor = saved.cursor;
    sim.clients[0] = SimClient::new("phone", Some(saved));
    sim.clients[0].map = map;
    sim.requests.clear();
    sim.bytes = 0;
    sim.open(0);
    sim.subscribe(0, &topic("session:a"), false);
    sim.tick(100);
    assert_eq!(sim.requests, vec![(topic("session:a"), cursor)]);
    assert_eq!(
        view(&sim.clients[0].map, &topic("session:a")),
        view(&sim.store.rows, &topic("session:a"))
    );
    assert!(
        sim.bytes < 3000,
        "a delta, not 50 rows again ({} B on the wire in all)",
        sim.bytes
    );
}

#[test]
fn drifted_a_row_the_client_lost_fails_the_next_patch_and_the_topic_starts_over_and_heals() {
    let mut store = FakeStore::default();
    store.commit(
        &[
            ch("list", "session", "s1", Op::Upsert(json!({"title": "one"}))),
            ch("list", "session", "s2", Op::Upsert(json!({"title": "two"}))),
        ],
        0,
    );
    let server = make_server(&store, |_| {});
    let mut sim = Sim::new(
        store,
        server,
        vec![SimClient::new("tab", None)],
        Rng::new(1),
        SimOpts::default(),
    );
    let list = topic("list");
    sim.subscribe(0, &list, false);
    sim.open(0);
    sim.tick(100);
    assert_eq!(view(&sim.clients[0].map, &list).len(), 2);
    sim.clients[0]
        .map
        .get_mut(&list)
        .unwrap()
        .remove(&key("session", "s1")); // the client store lost a row
    sim.requests.clear();
    sim.commit(&[ch(
        "list",
        "session",
        "s1",
        Op::Set(json!({"title": "uno"})),
    )]);
    sim.tick(100);
    assert_eq!(sim.clients[0].drifts, 1);
    assert_eq!(
        sim.requests,
        vec![(list.clone(), None)],
        "a full snapshot: the copy is not trusted"
    );
    assert_eq!(
        view(&sim.clients[0].map, &list),
        view(&sim.store.rows, &list)
    );
    // and the topic keeps streaming after it
    sim.tick(100);
    sim.commit(&[ch(
        "list",
        "session",
        "s2",
        Op::Set(json!({"title": "dos"})),
    )]);
    sim.tick(100);
    assert_eq!(
        view(&sim.clients[0].map, &list),
        view(&sim.store.rows, &list)
    );
    assert_eq!(sim.clients[0].drifts, 1);
}
