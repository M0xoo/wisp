//! A task topic's first look as a window (v1 #788): a seeded lead of 257 turns and 52 subagents, read the
//! way the stream read it before (the change feed: `changed_since(topic, 0)`) and as the window reads it.
//! `cargo test -p wisp-runtime --test turn_window -- --nocapture` prints both byte counts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout, clippy::cast_precision_loss, clippy::needless_pass_by_value)]

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use wisp_runtime::{schema, turn_window};
use wisp_runtime_core::turn_window::{WHOLE_TURNS, all_topic, turn_topic, turns_topic};
use wisp_store::{Location, Store, SystemClock};

const TURNS: usize = 257;
const SUBAGENTS: usize = 52;
const EVENTS_PER_TURN: usize = 40;

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn session(id: &str, parent: Option<&str>) -> Map<String, Value> {
    obj(json!({ "id": id, "parent_id": parent, "title": id, "state": "done", "agent": "claude", "archived": false, "unread": false,
      "created_at": 1, "updated_at": 2, "rev": 0, "body": { "cwd": "/w" }, "summary": { "turns": TURNS } }))
}

/// A turn as big as a real one: an answer of a few KB, a hero, and its edits.
fn turn(session: &str, idx: usize) -> Map<String, Value> {
    let id = format!("{session}-t{idx}");
    let text = "The answer, in a few paragraphs. ".repeat(60);
    let by = if idx == 3 { json!("compact") } else { Value::Null };
    obj(json!({ "id": id, "session_id": session, "idx": idx, "status": "done", "started_at": idx, "ended_at": idx + 1, "prompt": format!("ask {idx}"),
      "answer": text, "body": { "id": id, "sessionId": session, "idx": idx, "prompt": format!("ask {idx}"), "status": "done", "by": by, "text": text,
        "stats": { "inputTokens": 1000, "outputTokens": 200, "costUsd": 0.01 }, "nEvents": EVENTS_PER_TURN,
        "presentation": { "blocks": [{ "type": "hero", "title": format!("Did {idx}"), "summary": "what changed" }, { "type": "markdown", "text": text }] },
        "ext": { "wisp.git": { "checkpoint": { "to": "abc", "head": "def" } },
                 "wisp.runtime": { "changes": [{ "file": "/w/src/a.ts", "edits": [{ "old": "x".repeat(800), "new": "y".repeat(800) }] }] } } } }))
}

/// A tool call and its output (~1.5 KB, a Read or a Bash).
fn event(session: &str, turn: &str, seq: usize) -> Map<String, Value> {
    obj(json!({ "session_id": session, "seq": seq, "turn_id": turn, "t": seq, "kind": "tool", "v": 1,
      "body": { "kind": "tool", "tool": "read", "label": "Read src/a.ts", "file": "/w/src/a.ts", "output": "line of code\n".repeat(110) } }))
}

fn seed_task(store: &Store, id: &str, parent: Option<&str>, turns: usize) {
    let (id, parent) = (id.to_owned(), parent.map(str::to_owned));
    store
        .write_blocking(move |w| {
            w.upsert("session", session(&id, parent.as_deref()))?;
            let mut seq = 0;
            for i in 0..turns {
                let t = turn(&id, i);
                let tid = t["id"].as_str().unwrap().to_owned();
                w.upsert("turn", t)?;
                let evs = (0..EVENTS_PER_TURN)
                    .map(|_| {
                        seq += 1;
                        event(&id, &tid, seq)
                    })
                    .collect();
                w.append("event", evs)?;
            }
            Ok(())
        })
        .unwrap();
}

fn seeded() -> Store {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    schema::install(&store).unwrap();
    seed_task(&store, "lead", None, TURNS);
    for k in 0..SUBAGENTS {
        seed_task(&store, &format!("sub{k}"), Some("lead"), 6);
    }
    store
}

fn bytes(rows: &[(String, String, Map<String, Value>)]) -> usize {
    rows.iter().map(|(e, id, v)| serde_json::to_vec(&json!({ "e": e, "id": id, "v": v })).unwrap().len()).sum()
}

fn feed_rows(store: &Store, topic: &str) -> Vec<(String, String, Map<String, Value>)> {
    let d = store.read(|r| r.changed_since(topic, 0)).unwrap().unwrap();
    d.rows.into_iter().map(|(e, v)| (e, String::new(), v)).collect()
}

fn read(store: &Store, topic: &str) -> Vec<(String, String, Map<String, Value>)> {
    store.read(|r| turn_window::read(r, topic)).unwrap()
}

fn turns_of(rows: &[(String, String, Map<String, Value>)]) -> Vec<&Map<String, Value>> {
    rows.iter().filter(|(e, ..)| e == "turn").map(|(.., v)| v).collect()
}

fn stub(v: &Map<String, Value>) -> bool {
    v["body"].get("stub") == Some(&json!(true))
}

#[test]
fn a_long_task_with_many_subagents_opens_as_a_window_bytes_before_and_after() {
    let store = seeded();
    let before = feed_rows(&store, "session:lead");
    let after = read(&store, "session:lead");
    let (b, a) = (bytes(&before), bytes(&after));
    println!("session:lead first look, {TURNS} turns × {EVENTS_PER_TURN} events, {SUBAGENTS} subagents: before {b} B ({:.1} MB), after {a} B ({:.2} MB), {:.0}× less", b as f64 / 1e6, a as f64 / 1e6, b as f64 / a as f64);
    assert!(a * 10 < b, "the window is a tenth or less of the whole task: {a} vs {b}");
    let turns = turns_of(&after);
    assert_eq!(turns.len(), TURNS, "every turn is there, for the folded rows and the usage card");
    assert_eq!(turns.iter().filter(|t| !stub(t)).count(), WHOLE_TURNS);
    assert!(turns.iter().rev().take(WHOLE_TURNS).all(|t| !stub(t)), "the latest turns are the whole ones");
    let whole: BTreeSet<&str> = turns.iter().filter(|t| !stub(t)).map(|t| t["id"].as_str().unwrap()).collect();
    let events: Vec<_> = after.iter().filter(|(e, ..)| e == "event").collect();
    assert_eq!(events.len(), WHOLE_TURNS * EVENTS_PER_TURN);
    assert!(events.iter().all(|(.., v)| whole.contains(v["turn_id"].as_str().unwrap())), "only the whole turns' events");
    assert_eq!(after.iter().filter(|(e, ..)| e == "session").count(), 1);
}

#[test]
fn a_leads_window_carries_none_of_its_subagents_runs() {
    let store = seeded();
    let after = read(&store, "session:lead");
    assert!(after.iter().all(|(e, _, v)| e == "session" || v.get("session_id").and_then(Value::as_str) == Some("lead")));
    assert!(after.iter().all(|(e, id, _)| e != "session" || id == "lead"));
}

#[test]
fn a_stubbed_turn_keeps_its_stats_and_checkpoint_and_drops_its_answer_and_edits() {
    let store = seeded();
    let after = read(&store, "session:lead");
    let first = turns_of(&after)[0];
    assert!(stub(first));
    assert_eq!(first.get("answer"), None);
    assert_eq!(first["body"]["stats"]["inputTokens"], 1000);
    assert_eq!(first["body"]["ext"]["wisp.git"]["checkpoint"]["to"], "abc");
    assert_eq!(first["body"]["ext"]["wisp.runtime"].get("changes"), None);
    assert_eq!(first["body"]["presentation"]["blocks"][0]["title"], "Did 0");
}

#[test]
fn opening_an_older_turn_fetches_only_that_turn_and_its_events() {
    let store = seeded();
    let rows = read(&store, &turn_topic("lead", "lead-t5"));
    let turns = turns_of(&rows);
    assert_eq!(turns.len(), 1);
    assert!(!stub(turns[0]));
    assert_eq!(turns[0]["body"]["text"].as_str().map(str::len), Some("The answer, in a few paragraphs. ".len() * 60));
    let events: Vec<_> = rows.iter().filter(|(e, ..)| e == "event").collect();
    assert_eq!(events.len(), EVENTS_PER_TURN);
    assert!(events.iter().all(|(.., v)| v["turn_id"] == "lead-t5"));
    println!("one older turn opened: {} B", bytes(&rows));
}

#[test]
fn a_turn_topic_never_reads_another_tasks_turn() {
    let store = seeded();
    assert_eq!(read(&store, &turn_topic("lead", "sub0-t1")).len(), 0);
    assert_eq!(read(&store, &turn_topic("lead", "nope")).len(), 0);
}

#[test]
fn the_changes_pane_gets_every_turn_whole_without_events() {
    let store = seeded();
    let rows = read(&store, &turns_topic("lead"));
    assert_eq!(rows.len(), TURNS);
    assert!(rows.iter().all(|(e, _, v)| e == "turn" && !stub(v) && v["body"]["ext"]["wisp.runtime"]["changes"].is_array()));
}

#[test]
fn a_short_task_goes_whole() {
    let store = seeded();
    let rows = read(&store, "session:sub0");
    assert!(turns_of(&rows).iter().all(|t| !stub(t)));
    assert_eq!(rows.iter().filter(|(e, ..)| e == "event").count(), 6 * EVENTS_PER_TURN);
}

#[test]
fn a_compact_now_stub_keeps_what_it_did() {
    let store = seeded();
    let rows = read(&store, "session:lead");
    let t3 = turns_of(&rows)[3];
    assert!(stub(t3));
    assert_eq!(t3["body"]["presentation"]["blocks"][1]["type"], "markdown");
}

#[test]
fn the_tuis_all_view_reads_every_turn_whole_with_every_event_from_the_tables() {
    let store = seeded();
    let rows = read(&store, &all_topic("lead"));
    assert!(turns_of(&rows).iter().all(|t| !stub(t)));
    assert_eq!(turns_of(&rows).len(), TURNS);
    assert_eq!(rows.iter().filter(|(e, ..)| e == "event").count(), TURNS * EVENTS_PER_TURN);
    println!("session:lead/all: {} B", bytes(&rows));
}
