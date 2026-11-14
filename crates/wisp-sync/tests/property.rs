//! Property: any interleaving of commits, ticks, slow sockets (resync), lost frames, reconnects that
//! resume and reconnects that can't (retention, a restored epoch), late snapshot answers and
//! sub/unsub churn leaves every client's map equal to the store, topic by topic. Clients follow the
//! shipped TS client's rules (tests/support/client.rs); frames go through the real SSE codec.
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

use std::collections::BTreeSet;

use serde_json::{Value, json};
use support::{FakeStore, Op, Rng, Sim, SimClient, SimOpts, TestChange, make_server, topic, view};
use wisp_protocol::Topic;
use wisp_sync::Input;

const TOPICS: [&str; 4] = ["list", "session:a", "session:b", "machines"];

fn value(r: &mut Rng) -> Value {
    let n = r.below(4);
    let mut v =
        json!({ "title": format!("t{}", r.below(5)), "n": r.below(3), "tags": (0..n).map(|i| format!("x{i}")).collect::<Vec<_>>() });
    if r.next() < 0.5 {
        v["extra"] = json!({ "deep": if r.next() < 0.5 { json!(1) } else { json!("a/b~c") } });
    }
    v
}

fn change(r: &mut Rng) -> TestChange {
    let t = topic(TOPICS[r.below(TOPICS.len())]);
    let id = format!("r{}", r.below(5));
    let k = r.next();
    let (e, id, op) = if k < 0.15 {
        ("log", "l0".to_owned(), Op::Append(vec![json!(r.below(100))]))
    } else if k < 0.3 {
        ("row", id, Op::Del)
    } else if k < 0.45 {
        ("row", id, Op::Upsert(value(r)))
    } else {
        ("row", id, Op::Set(value(r)))
    };
    TestChange { topic: t, e: e.into(), id, op }
}

#[derive(Debug, Default)]
struct Seen {
    resyncs: u32,
    resumes: u32,
    resets: u32,
    drifts: u32,
}

struct World {
    r: Rng,
    sim: Sim,
    subs: Vec<BTreeSet<Topic>>,
    flush: u64,
    epoch: u32,
}

fn server_for(store: &FakeStore, epoch: u32, flush: u64) -> wisp_sync::SyncServer<String> {
    make_server(store, |o| {
        o.epoch = format!("E{epoch}");
        o.flush_ms = flush;
        o.high_water_bytes = 4000;
    })
}

fn setup(seed: u32) -> World {
    let mut r = Rng::new(seed);
    let store = FakeStore::default();
    let flush = 20 + r.below(60) as u64;
    let opts = SimOpts { async_answers: true, wire: true, chunked: r.next() < 0.5 };
    let server = server_for(&store, 1, flush);
    let clients = ["A", "B", "C"].iter().map(|n| SimClient::new(n, None)).collect();
    let mut sim = Sim::new(store, server, clients, Rng::new(seed.wrapping_mul(7919)), opts);
    let mut subs = Vec::new();
    for ci in 0..3 {
        let mine: BTreeSet<Topic> = [topic("list"), topic(TOPICS[1 + r.below(3)])].into();
        for t in &mine {
            let passive = r.next() < 0.3;
            sim.subscribe(ci, t, passive);
        }
        sim.open(ci);
        subs.push(mine);
    }
    World { r, sim, subs, flush, epoch: 1 }
}

/// One random thing happens.
fn step(w: &mut World) {
    let k = w.r.next();
    let ci = w.r.below(3);
    let sim = &mut w.sim;
    if k < 0.35 {
        let n = 1 + w.r.below(3);
        let changes: Vec<_> = (0..n).map(|_| change(&mut w.r)).collect();
        sim.commit(&changes);
    } else if k < 0.55 {
        sim.tick(w.r.below(80) as u64);
    } else if k < 0.68 {
        sim.deliver(ci, 1 + w.r.below(3));
    } else if k < 0.74 {
        sim.answer_all();
    } else if k < 0.79 {
        sim.clients[ci].backlog = if w.r.next() < 0.5 { 10_000 } else { 0 }; // a slow phone
    } else if k < 0.85 {
        sim.lose(ci);
        sim.open(ci);
    } else if k < 0.88 {
        let up_to = sim.store.seq.saturating_sub(w.r.below(3) as u64); // retention passes a cursor
        sim.store.trim(up_to);
        let oldest_seq = sim.store.oldest;
        sim.server_in(Input::Retained { oldest_seq });
    } else if k < 0.9 {
        // a restore: a new epoch, every cursor from before is void
        w.epoch += 1;
        sim.server = server_for(&sim.store, w.epoch, w.flush);
        for x in 0..3 {
            sim.lose(x);
        }
        sim.drop_answers();
        for x in 0..3 {
            sim.open(x);
        }
    } else if k < 0.96 {
        let t = topic(TOPICS[w.r.below(TOPICS.len())]);
        if w.subs[ci].contains(&t) {
            if t.as_str() != "list" {
                w.subs[ci].remove(&t);
                sim.unsubscribe(ci, &t);
            }
        } else {
            w.subs[ci].insert(t.clone());
            sim.subscribe(ci, &t, false);
        }
    } else if sim.clients[ci].conn.is_none() {
        sim.open(ci);
    }
}

/// Sockets drain, answers come, every client is connected, until nothing is left to send.
fn settle(w: &mut World) {
    let sim = &mut w.sim;
    for ci in 0..3 {
        sim.clients[ci].backlog = 0;
        match sim.clients[ci].conn {
            Some(conn) => sim.server_in(Input::Drained { conn, buffered_bytes: 0 }),
            None => sim.open(ci),
        }
    }
    for _ in 0..200 {
        sim.answer_all();
        sim.tick(w.flush);
        for ci in 0..3 {
            sim.deliver(ci, usize::MAX);
        }
        if sim.pending_answers() == 0 && sim.clients.iter().all(|c| c.transit.is_empty()) {
            let wake = sim.server.next_wake_at();
            if wake.is_none_or(|at| at > sim.now + w.flush * 2) {
                break;
            }
        }
    }
}

fn run(seed: u32, seen: &mut Seen) {
    let mut w = setup(seed);
    for _ in 0..250 {
        step(&mut w);
    }
    settle(&mut w);
    for (ci, c) in w.sim.clients.iter().enumerate() {
        seen.resyncs += c.resyncs;
        seen.resets += c.resets;
        seen.resumes += c.lives.saturating_sub(c.resets);
        seen.drifts += c.drifts;
        for t in &w.subs[ci] {
            assert_eq!(
                view(&c.map, t),
                view(&w.sim.store.rows, t),
                "seed {seed}: client {}, topic {t} (cursor {:?}, head {})",
                c.name,
                c.client.cursor,
                w.sim.store.seq
            );
        }
    }
}

#[test]
fn any_interleaving_leaves_every_client_equal_to_the_store() {
    let mut seen = Seen::default();
    for seed in 1..=400 {
        run(seed, &mut seen);
    }
    // every path was taken, and no op ever failed to apply (a drift heals itself, so it would hide a bug)
    assert!(seen.resyncs > 100 && seen.resumes > 500 && seen.resets > 500, "{seen:?}");
    assert_eq!(seen.drifts, 0, "{seen:?}");
}
