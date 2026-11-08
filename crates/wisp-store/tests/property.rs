//! Property: whatever sequence of upsert / patch / del / append runs (refused ops and rolled-back
//! transactions included), replaying the change feed over an empty map gives the tables' state, and what
//! listeners hear is exactly what `changes_since` reads back (property.test.ts: 25 seeds × 40 txs).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

mod common;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use common::{event, open, session_with};
use serde_json::{Value, json};
use wisp_store::json_patch::apply;
use wisp_store::{ChangeOp, ChangeRow, PatchOp, Query, Row, Store, StoreError, Writer};

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u32) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (((self.0 >> 33) as f64 / (1u64 << 31) as f64) * f64::from(n)) as u32
    }
}

fn key(entity: &str, id: &Value) -> String {
    format!(
        "{entity}/{}",
        id.as_str().map_or_else(|| id.to_string(), str::to_owned)
    )
}

fn replay(feed: &[ChangeRow]) -> BTreeMap<String, Value> {
    let mut state = BTreeMap::new();
    for c in feed {
        let k = format!("{}/{}", c.entity, c.id);
        match c.op {
            ChangeOp::Upsert => {
                state.insert(k, c.patch.clone());
            }
            ChangeOp::Patch => {
                let ops: Vec<PatchOp> = serde_json::from_value(c.patch.clone()).unwrap();
                let next = apply(&state[&k], &ops).unwrap();
                state.insert(k, next);
            }
            ChangeOp::Del => {
                state.remove(&k);
            }
            ChangeOp::Append => {
                for r in c.patch.as_array().unwrap() {
                    state.insert(key(&c.entity, &r["id"]), r.clone());
                }
            }
        }
    }
    state
}

fn tables(store: &Store) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for kind in ["session", "event"] {
        for r in store.query(kind, &Query::new()).unwrap() {
            out.insert(key(kind, &r["id"]), Value::Object(r));
        }
    }
    out
}

fn random_patch(r: &mut Rng, row: &Row) -> Vec<PatchOp> {
    (0..=r.below(3))
        .map(|_| match r.below(20) {
            0..=5 => PatchOp::replace(
                &["title"],
                if r.below(5) == 0 {
                    Value::Null
                } else {
                    json!(format!("t{}", r.below(5)))
                },
            ),
            6..=9 => PatchOp::replace(&["archived"], json!(r.below(2) == 0)),
            10..=13 => PatchOp::replace(&["extra"], json!({"tags": [], "n": r.below(3)})),
            14..=16 if !row["extra"].is_null() => PatchOp::add(
                &["extra", "k"],
                [json!(1), json!("two"), json!({"three": 3})][r.below(3) as usize].clone(),
            ),
            _ => PatchOp::replace(&["updated_at"], json!(r.below(100))),
        })
        .collect()
}

fn step(
    w: &mut Writer<'_>,
    r: &mut Rng,
    next_seq: &mut HashMap<String, i64>,
) -> Result<(), StoreError> {
    let id = format!("s{}", r.below(6));
    let exists = w.get("session", id.as_str())?;
    match (r.below(20), exists) {
        (0..=5, _) => {
            let extra = if r.below(2) == 0 {
                Value::Null
            } else {
                json!({"tags": ["a"]})
            };
            w.upsert(
                "session",
                session_with(
                    &id,
                    json!({"title": format!("u{}", r.below(4)), "extra": extra}),
                ),
            )?;
        }
        (6..=10, Some(row)) => {
            w.patch("session", id.as_str(), &random_patch(r, &row))?;
        }
        (11..=12, Some(_)) => {
            // the session's events go first: the event log references the session
            for e in w.query("event", &Query::new().eq("session_id", id.as_str()))? {
                w.del("event", e["id"].as_i64().unwrap())?;
            }
            w.del("session", id.as_str())?;
        }
        (_, Some(_)) => {
            let n = 1 + i64::from(r.below(4));
            let s0 = *next_seq.get(&id).unwrap_or(&0);
            next_seq.insert(id.clone(), s0 + n);
            w.append(
                "event",
                (0..n)
                    .map(|i| event(&id, s0 + i, "text", json!({"i": i})))
                    .collect(),
            )?;
        }
        _ => {}
    }
    Ok(())
}

#[test]
fn replaying_the_change_feed_over_an_empty_map_equals_the_tables() {
    for seed in 1..=25u64 {
        let f = open();
        let rng = Arc::new(Mutex::new(Rng(seed)));
        let next_seq = Arc::new(Mutex::new(HashMap::new()));
        for _ in 0..40 {
            let (rng, next_seq) = (rng.clone(), next_seq.clone());
            let _ = f.store.write_blocking(move |w| {
                let mut r = rng.lock().unwrap();
                let mut seqs = next_seq.lock().unwrap();
                let roll_back = r.below(10) == 0;
                for _ in 0..=r.below(4) {
                    step(w, &mut r, &mut seqs)?;
                }
                if roll_back {
                    Err(StoreError::Internal("rolled back".into()))
                } else {
                    Ok(())
                }
            });
        }
        let feed = f.store.changes_since(0, None, 10_000).unwrap();
        assert_eq!(replay(&feed), tables(&f.store), "seed {seed}");
    }
}

#[test]
fn what_listeners_hear_is_exactly_what_changes_since_reads_back() {
    let f = open();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let h = heard.clone();
    let _sub = f
        .store
        .on_commit(move |c| h.lock().unwrap().extend(c.iter().cloned()));
    let rng = Arc::new(Mutex::new(Rng(99)));
    let next_seq = Arc::new(Mutex::new(HashMap::new()));
    for _ in 0..60 {
        let (rng, next_seq) = (rng.clone(), next_seq.clone());
        f.store
            .write_blocking(move |w| {
                step(w, &mut rng.lock().unwrap(), &mut next_seq.lock().unwrap())
            })
            .unwrap();
    }
    let heard = heard.lock().unwrap().clone();
    assert!(heard.len() > 20);
    assert_eq!(heard, f.store.changes_since(0, None, 10_000).unwrap());
}
