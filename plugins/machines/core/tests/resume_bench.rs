//! Bench (plan §7.2.6 "reconnects after sleep are incremental"): bytes a peer sends when this wisp
//! comes back to a box with 1,000 sessions after a night, v2 (resume from the cursor) against v1
//! (a full `GET /sessions?here=1` and a fresh `/api/events`). Both sides are run through the real
//! code: the v2 bytes are SSE frames decoded by `SseParser`, fed to `PeerClient` and applied to the
//! `Mirror`, which must then equal the box's own list.
//!
//! `cargo test -p wisp-machines-core --release --test resume_bench -- --ignored --nocapture` prints the
//! table; the plain test run checks the ratio.
use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::{Value, json};
use wisp_machines_core::mirror::Mirror;
use wisp_machines_core::peer_client::{Opts, Out, PeerClient, decode_frame};
use wisp_machines_core::sse::SseParser;
use wisp_protocol::{Change, EntityOp, Topic, diff};

const SESSIONS: usize = 1_000;

/// A task summary as v1's list carried it (server/sessions summary shape, ~0.7 KB).
fn summary(i: usize, rev: u64) -> Value {
    json!({
        "id": format!("0190a1b2c3d4e5f6a7b8{i:012x}"), "title": format!("Fix the flaky upload test in packages/sync #{i}"),
        "agent": ["claude", "codex", "opencode"][i % 3], "model": "claude-opus-4-1", "effort": "high", "mode": "auto",
        "state": if rev > 0 && i % 7 == 0 { "running" } else { "done" }, "cwd": format!("/Users/me/code/project-{}", i % 12),
        "project": format!("project-{}", i % 12), "color": "#7c5cff", "branch": format!("wisp/fix-upload-{i}"),
        "worktree": format!("/Users/me/.wisp/worktrees/project-{}-{i}", i % 12), "createdAt": 1_762_560_000_000_u64 + i as u64 * 60_000,
        "updatedAt": 1_762_600_000_000_u64 + rev * 1_000 + i as u64, "lastActivityAt": 1_762_600_000_000_u64 + rev * 1_000,
        "turns": 3 + (i % 9) as u64 + rev, "unread": rev > 0, "archived": false, "pinned": i % 50 == 0,
        "cost": { "usd": 0.42 + (i % 10) as f64 / 10.0, "tokensIn": 182_000 + i as u64, "tokensOut": 9_400 + rev },
        "preview": "Fixed: the upload retried after the server had already stored it; now the idempotency key is checked first.",
        "groupId": null, "parentId": null, "machine": null, "crew": null, "labels": ["ci", "sync"], "goal": null,
    })
}

fn sse(id: u64, messages: &Value) -> String {
    format!("id: {id}\nevent: sync\ndata: {messages}\n\n")
}

fn welcome(resume: bool, head: u64) -> Value {
    json!({"t": "welcome", "epoch": "E1", "head_seq": head, "oldest_seq": 0, "resume": resume, "proto": 2,
        "peer": {"peer": "box", "name": "wisp Cloud", "build": "b", "version": "2.0.0", "proto_min": 2, "proto_max": 2, "plugins": []}})
}

struct Run {
    v1_bytes: usize,
    v2_bytes: usize,
    v2_apply_us: u128,
}

/// The box's list before the night, and after `changed` sessions moved on (`new` started).
fn night(changed: usize, new: usize) -> (BTreeMap<String, Value>, BTreeMap<String, Value>) {
    let before: BTreeMap<String, Value> = (0..SESSIONS)
        .map(|i| summary(i, 0))
        .map(|s| (s["id"].as_str().unwrap_or("").to_owned(), s))
        .collect();
    let mut after = before.clone();
    for i in (0..SESSIONS)
        .step_by((SESSIONS / changed.max(1)).max(1))
        .take(changed)
    {
        let s = summary(i, 1);
        after.insert(s["id"].as_str().unwrap_or("").to_owned(), s);
    }
    for i in SESSIONS..SESSIONS + new {
        let s = summary(i, 1);
        after.insert(s["id"].as_str().unwrap_or("").to_owned(), s);
    }
    (before, after)
}

fn run(changed: usize, new: usize) -> Run {
    let (before, after) = night(changed, new);
    // v1: the whole list again, as JSON, plus the stream's opening `hello` (one small event)
    let v1_bytes = serde_json::to_vec(&after.values().collect::<Vec<_>>()).map_or(0, |b| b.len())
        + "event: hello\ndata: {}\n\n".len();

    // v2: the mirror holds `before` as of seq 1000; the box sends welcome(resume) + one patch per change
    let mut mirror = Mirror::new();
    for (id, v) in &before {
        mirror.load("box", "session", id, v.clone());
    }
    let saved = wisp_machines_core::peer_client::Saved {
        epoch: Some("E1".into()),
        cursor: Some(1_000),
        synced: vec![Topic::list()],
        ..Default::default()
    };
    let mut client = PeerClient::new(Opts::new("laptop", "b"), Some(saved));
    client.subscribe(&Topic::list(), true);
    let hello = client.open();
    let query: usize = hello
        .iter()
        .map(|o| {
            if let Out::Request(p) = o {
                p.iter().map(|(k, v)| k.len() + v.len() + 2).sum()
            } else {
                0
            }
        })
        .sum();

    let mut stream = sse(1_000, &json!([welcome(true, 1_000 + changed as u64)]));
    for (n, (id, v)) in after
        .iter()
        .filter(|(id, v)| before.get(*id) != Some(*v))
        .enumerate()
    {
        let seq = 1_001 + n as u64;
        let change = match before.get(id) {
            Some(old) => Change::Patch { ops: diff(old, v) },
            None => Change::Upsert { v: v.clone() },
        };
        let op = EntityOp {
            topic: Topic::list(),
            e: "session".into(),
            id: id.clone(),
            change,
        };
        stream.push_str(&sse(seq, &json!([{"t": "patch", "seq": seq, "ops": [op]}])));
    }
    let v2_bytes = stream.len() + query;

    let t0 = Instant::now();
    let mut parser = SseParser::new();
    for ev in parser.push(stream.as_bytes()) {
        let Some((id, messages)) = decode_frame(&ev.event, ev.id.as_deref(), &ev.data) else {
            continue;
        };
        for out in client.frame(id, messages) {
            assert!(!matches!(out, Out::Reset), "a resume must not reset");
            if let Out::EntityOps(ops) = out {
                assert!(mirror.apply("box", ops).1.is_empty(), "no drift");
            }
        }
    }
    let v2_apply_us = t0.elapsed().as_micros();
    // the mirror is the box's list, exactly
    let got: BTreeMap<String, Value> = mirror
        .rows(Some("box"))
        .into_iter()
        .map(|r| (r.id, r.v))
        .collect();
    assert_eq!(got, after, "the resumed mirror is the box's list");
    assert_eq!(client.cursor(), Some(1_000 + (changed + new) as u64));
    Run {
        v1_bytes,
        v2_bytes,
        v2_apply_us,
    }
}

#[test]
fn a_night_of_sleep_resumes_in_a_fraction_of_v1s_bytes() {
    let quiet = run(0, 0);
    let busy = run(10, 2);
    assert!(
        quiet.v2_bytes * 100 < quiet.v1_bytes,
        "nothing changed: {} vs {}",
        quiet.v2_bytes,
        quiet.v1_bytes
    );
    assert!(
        busy.v2_bytes * 20 < busy.v1_bytes,
        "12 changed: {} vs {}",
        busy.v2_bytes,
        busy.v1_bytes
    );
}

#[test]
#[ignore = "bench: prints the table"]
fn bench_resume_after_sleep() {
    eprintln!("| changed overnight | v1 full resync | v2 resume | ratio | v2 decode+apply |");
    eprintln!("|---|---|---|---|---|");
    for (changed, new) in [(0, 0), (10, 2), (50, 10), (200, 20), (1_000, 0)] {
        let r = run(changed, new);
        #[expect(clippy::cast_precision_loss, reason = "a ratio for a table")]
        let ratio = r.v1_bytes as f64 / r.v2_bytes.max(1) as f64;
        eprintln!(
            "| {changed} + {new} new | {} B | {} B | {ratio:.0}× | {} µs |",
            r.v1_bytes, r.v2_bytes, r.v2_apply_us
        );
    }
}
