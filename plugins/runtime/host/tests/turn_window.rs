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

/// An older turn changes (a late rating, an edited answer, one more edit) after the window was read.
fn rate(store: &Store, id: &str, text: &str) -> Vec<wisp_store::ChangeRow> {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let tap = seen.clone();
    let _sub = store.on_commit(move |rows| tap.lock().unwrap().extend(rows.iter().cloned()));
    let (id, text) = (id.to_owned(), text.to_owned());
    store
        .write_blocking(move |w| {
            let mut t = w.get("turn", id.as_str())?.unwrap();
            let body = t.get_mut("body").and_then(Value::as_object_mut).unwrap();
            body.insert("text".into(), json!(text));
            body["ext"].as_object_mut().unwrap().insert("wisp.telemetry".into(), json!({ "feedback": { "rating": "down" } }));
            body["ext"]["wisp.runtime"]["changes"].as_array_mut().unwrap().push(json!({ "file": "/w/src/b.ts", "edits": [] }));
            body["presentation"]["blocks"][1]["text"] = json!(text);
            t.insert("answer".into(), json!(text));
            w.upsert("turn", t)?;
            Ok(())
        })
        .unwrap();
    seen.lock().unwrap().clone()
}

fn live(store: &Store, topic: &str, id: &str) -> Option<turn_window::Rows> {
    store.read(|r| turn_window::live(r, topic, "turn", id)).unwrap()
}

/// The gap the window left (ADR-0051): the store's diff of a stubbed turn doesn't apply to the stub a client
/// holds (its answer, text and blocks are gone), so the client resynced and re-read the whole window. The
/// change now goes as the stub itself: it applies, and the client's copy is the stub a fresh window sends.
#[test]
fn a_change_to_a_stubbed_turn_goes_as_its_stub_so_a_client_holding_stubs_never_drifts() {
    let store = seeded();
    let window = read(&store, "session:lead");
    let held = turns_of(&window).into_iter().find(|t| t["id"] == "lead-t5").unwrap().clone();
    assert!(stub(&held));
    let changes = rate(&store, "lead-t5", "a new answer");
    let diff = changes.iter().find(|c| c.entity == "turn" && c.op == wisp_store::ChangeOp::Patch).expect("the store records a diff");
    let ops: Vec<wisp_store::PatchOp> = serde_json::from_value(diff.patch.clone()).unwrap();
    // `add /body/ext/wisp.runtime/changes/-`: the stub has no `changes`; and without it the stub would take the
    // answer, the text and every block (`replace` on a missing key inserts), a stub no longer
    assert!(wisp_store::json_patch::apply(&Value::Object(held.clone()), &ops).is_err(), "as committed, the diff fails on the stub");
    let no_append: Vec<_> = ops.iter().filter(|o| !o.path().ends_with("/-")).cloned().collect();
    let hybrid = wisp_store::json_patch::apply(&Value::Object(held.clone()), &no_append).unwrap();
    assert_eq!(hybrid["answer"], "a new answer", "and what applies turns the stub into a hybrid");

    let sent = live(&store, "session:lead", "lead-t5").expect("a stubbed turn goes another way");
    let topics: Vec<&str> = sent.iter().map(|(t, ..)| t.as_str()).collect();
    assert_eq!(topics, ["session:lead", "session:lead/all", "session:lead/turn/lead-t5", "session:lead/turns"]);
    let mut flushed = topics.clone();
    flushed.sort_unstable(); // the outbox takes a rank's topics by name
    assert_eq!(topics, flushed, "the window's stub goes first, the whole rows after it, in one flush");
    let fresh = read(&store, "session:lead");
    let now = turns_of(&fresh).into_iter().find(|t| t["id"] == "lead-t5").unwrap();
    assert_eq!(&sent[0].2, now, "the window's change is the stub a fresh window sends: no drift");
    assert_eq!(sent[0].2["body"]["ext"]["wisp.telemetry"]["feedback"]["rating"], "down");
    assert_eq!(sent[0].2.get("answer"), None);
    for (_, id, v) in &sent[1..] {
        assert_eq!(id, "lead-t5");
        assert!(!stub(v), "whole on the topics that hold it whole");
        assert_eq!(v["answer"], "a new answer");
    }
}

#[test]
fn a_change_to_a_whole_turn_goes_as_committed() {
    let store = seeded();
    let latest = format!("lead-t{}", TURNS - 1);
    let boundary = format!("lead-t{}", TURNS - WHOLE_TURNS);
    rate(&store, &latest, "x");
    assert!(live(&store, "session:lead", &latest).is_none(), "the running turn's diffs stay diffs");
    assert!(live(&store, "session:lead", &boundary).is_none(), "the oldest whole turn is whole");
    assert!(live(&store, "session:lead", &format!("lead-t{}", TURNS - WHOLE_TURNS - 1)).is_some(), "the one before it is a stub");
    assert!(live(&store, "session:sub0", "sub0-t0").is_none(), "a short task sends every turn whole");
    assert!(live(&store, "session:lead", "sub0-t0").is_none(), "another task's turn isn't the window's");
    assert!(live(&store, "session:lead/turns", "lead-t5").is_none(), "only the window stubs");
    assert!(store.read(|r| turn_window::live(r, "session:lead", "session", "lead")).unwrap().is_none(), "only turns");
}

#[test]
fn a_resumed_window_sends_the_older_turns_it_stubs_as_stubs() {
    let store = seeded();
    #[allow(clippy::redundant_closure_for_method_calls)] // the method path isn't general over the reader's lifetime
    let head = store.read(|r| r.head_seq()).unwrap();
    rate(&store, "lead-t5", "y");
    rate(&store, &format!("lead-t{}", TURNS - 1), "z");
    let mut rows = store.read(|r| r.changed_since("session:lead", head)).unwrap().unwrap().rows;
    store.read(|r| turn_window::delta(r, "session:lead", &mut rows)).unwrap();
    let by = |id: &str| rows.iter().find(|(e, v)| e == "turn" && v["id"] == id).map(|(_, v)| v).unwrap();
    assert!(stub(by("lead-t5")), "an older turn resumes as its stub");
    assert!(!stub(by(&format!("lead-t{}", TURNS - 1))), "a whole one resumes whole");
    let mut whole = store.read(|r| r.changed_since("session:lead", head)).unwrap().unwrap().rows;
    store.read(|r| turn_window::delta(r, "session:lead/turns", &mut whole)).unwrap();
    assert!(whole.iter().all(|(_, v)| !stub(v)), "only the window stubs");
}
