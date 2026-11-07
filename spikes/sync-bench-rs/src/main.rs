//! Gate G3 (plan §9.1): topic SSE fan-out. 4 clients, 10 running tasks streaming.
//!   pass: bytes sent ≥ 5× fewer than v1, CPU ≤ v1's
//!   run:  cargo run --release --manifest-path spikes/sync-bench-rs/Cargo.toml -- [--seconds=120] [--seed=1]
//!
//! A port of spikes/sync-bench/g3.ts with the same workload, event for event. v1 (server/http/
//! respond.js): every client gets every frame: per harness event an `activity` {sessionId, turnId,
//! item}, a tool call also broadcasts the session's whole `summary` row, a tool's output re-sends its
//! activity item, plus `ping` every 25 s. v2: the same events become change rows (an event upsert or
//! patch on session:<id>, a patch of the session's list row) fed to wisp-sync's SyncServer; each
//! client holds `list` and, in the second run, one open task.
#![allow(clippy::print_stdout)]

use std::collections::HashMap;
use std::time::Instant;

use serde_json::{Value, json};
use wisp_protocol::{Change, PatchOp, PeerInfo, Row, Topic, diff};
use wisp_sync::{
    ChangeRow, ConnId, ConnectQuery, Input, Output, SnapshotAnswer, SyncOptions, SyncServer,
};

const CLIENTS: u64 = 4;
const TASKS: usize = 10;
const WORDS: [&str; 9] = [
    "the", "test", "file", "runs", "build", "server", "fix", "check", "route",
];

fn arg(name: &str, def: f64) -> f64 {
    std::env::args()
        .find_map(|a| {
            a.strip_prefix(&format!("--{name}="))
                .and_then(|v| v.parse().ok())
        })
        .unwrap_or(def)
}

/// g3.ts's `rand`, with JavaScript's number semantics (a double product, then ToInt32).
struct Lcg(f64);

impl Lcg {
    fn next(&mut self) -> f64 {
        let x = (self.0 * 1_103_515_245.0 + 12_345.0).rem_euclid(4_294_967_296.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let i = (x as u64) & 0x7fff_ffff;
        #[allow(clippy::cast_precision_loss)]
        let f = i as f64;
        self.0 = f;
        f / f64::from(0x7fff_ffff_u32)
    }

    fn words(&mut self, n: usize) -> String {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let pick = |r: &mut Self| WORDS[(r.next() * 9.0) as usize];
        (0..n).map(|_| pick(self)).collect::<Vec<_>>().join(" ")
    }
}

/// A summary row as v1's summarize() returns it for a running task in a project, with a PR.
fn summary(i: usize, t: u64, live: &str) -> Value {
    json!({
        "id": format!("s-{i}-0193c2a4-7b1e-7c3d-9f2a"), "title": format!("Fix the flaky upload test in the API {i}"), "agent": "claude", "cwd": format!("/Users/me/code/api-{i}"),
        "project": format!("api-{i}"), "projectId": format!("p{i}"), "color": "violet", "mode": "auto", "model": "opus", "effort": "high", "state": "running", "unread": false, "archived": false,
        "createdAt": 1_730_900_000_000_u64 + i as u64, "updatedAt": t, "turnCount": 3, "queued": 0, "later": [], "status": "running", "preview": "Tests pass; the upload retries now back off.",
        "live": live, "asks": false, "question": "", "approval": false, "branch": format!("wisp/fix-upload-{i}"), "keepWorktree": false, "foreign": "",
        "toShip": { "dirty": 2, "ahead": 1, "unpushed": 1 }, "shipping": null, "pr": { "number": 700 + i, "url": format!("https://github.com/acme/api/pull/{}", 700 + i), "state": "open", "draft": false, "review": null, "checks": "pending", "conflict": false },
        "conflictFix": null, "review": null, "groupId": null, "origin": null, "usage": { "input": 182_000 + t % 1000, "output": 9100, "cost": 1.92 }, "plan": { "session5h": 0.21, "weekly": 0.04 },
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Tool,
    Output,
    Text,
}

struct Ev {
    at: u64,
    task: usize,
    kind: Kind,
    n: u32,
    item: Value,
    output: String,
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn floor(x: f64) -> u64 {
    x.floor() as u64
}

/// Each task: a tool call every ~1.5 s, its output ~0.8 s later, a text step now and then.
fn workload(r: &mut Lcg, seconds: f64) -> Vec<Ev> {
    let mut evs = Vec::new();
    for task in 0..TASKS {
        let mut n = 0;
        let mut t = r.next() * 1000.0;
        while t < seconds * 1000.0 {
            n += 1;
            let at = floor(t);
            let item = json!({ "t": at, "kind": "run", "label": format!("Running {}", r.words(3)), "detail": format!("npm test -- {}", r.words(2)), "call": format!("toolu_{task}_{n}") });
            evs.push(Ev {
                at,
                task,
                kind: Kind::Tool,
                n,
                item,
                output: String::new(),
            });
            let out_at = floor(t + 300.0 + r.next() * 1000.0);
            let output = (0..12).map(|_| r.words(10)).collect::<Vec<_>>().join("\n");
            evs.push(Ev {
                at: out_at,
                task,
                kind: Kind::Output,
                n,
                item: json!({}),
                output,
            });
            if r.next() < 0.35 {
                n += 1;
                let at = floor(t + 100.0);
                evs.push(Ev {
                    at,
                    task,
                    kind: Kind::Text,
                    n,
                    item: json!({ "t": at, "kind": "text", "label": r.words(40) }),
                    output: String::new(),
                });
            }
            t += 800.0 + r.next() * 1400.0;
        }
    }
    evs.sort_by_key(|e| e.at); // stable, as JS's sort
    evs
}

struct Run {
    bytes: u64,
    frames: u64,
    cpu_ms: f64,
    changes: usize,
}

fn v1(evs: &[Ev]) -> Run {
    let mut clients: Vec<Vec<String>> = vec![Vec::new(); CLIENTS as usize];
    let (mut bytes, mut frames) = (0, 0);
    let mut items: HashMap<(usize, u32), Value> = HashMap::new();
    let cpu = Instant::now();
    let mut broadcast = |event: &str, data: &Value| {
        let frame = format!(
            "event: {event}\ndata: {}\n\n",
            serde_json::to_string(data).unwrap_or_default()
        );
        for c in &mut clients {
            bytes += frame.len() as u64;
            frames += 1;
            c.push(frame.clone());
            if c.len() > 256 {
                c.clear(); // a socket write: kept from growing in the bench
            }
        }
    };
    let mut next_ping = 25_000;
    for e in evs {
        while next_ping <= e.at {
            broadcast("ping", &json!({}));
            next_ping += 25_000;
        }
        let key = (e.task, e.n);
        let (sid, tid) = (format!("s-{}", e.task), format!("t-{}", e.task));
        if e.kind == Kind::Output {
            let Some(it) = items.get_mut(&key) else {
                continue;
            };
            it["output"] = json!(e.output);
            it["outAt"] = json!(e.at);
            broadcast(
                "activity",
                &json!({ "sessionId": sid, "turnId": tid, "item": it, "update": true }),
            );
            continue;
        }
        items.insert(key, e.item.clone());
        broadcast(
            "activity",
            &json!({ "sessionId": sid, "turnId": tid, "item": e.item }),
        );
        if e.kind == Kind::Tool {
            broadcast(
                "summary",
                &summary(e.task, e.at, e.item["label"].as_str().unwrap_or("")),
            );
        }
    }
    Run {
        bytes,
        frames,
        cpu_ms: cpu.elapsed().as_secs_f64() * 1000.0,
        changes: 0,
    }
}

type Batch = (u64, Vec<(Topic, &'static str, String, Change)>);

/// What the store writes for the events (its work, done before timing): an event row, the list row's patch.
fn change_rows(evs: &[Ev]) -> (Vec<Batch>, Vec<Row>) {
    let mut rows: HashMap<String, Value> = (0..TASKS)
        .map(|i| (format!("s-{i}"), summary(i, 0, "Starting up")))
        .collect();
    let start: Vec<Row> = (0..TASKS)
        .map(|i| Row {
            e: "session".into(),
            id: format!("s-{i}"),
            v: rows[&format!("s-{i}")].clone(),
        })
        .collect();
    let mut batches = Vec::new();
    for e in evs {
        let topic = Topic::session(&format!("s-{}", e.task)).unwrap_or_else(Topic::list);
        let key = format!("{}:{}", e.task, e.n);
        if e.kind == Kind::Output {
            let ops = vec![
                PatchOp::Add {
                    path: "/output".into(),
                    value: json!(e.output),
                },
                PatchOp::Add {
                    path: "/outAt".into(),
                    value: json!(e.at),
                },
            ];
            batches.push((e.at, vec![(topic, "event", key, Change::Patch { ops })]));
            continue;
        }
        let id = format!("s-{}", e.task);
        let prev = rows[&id].clone();
        let mut next = prev.clone();
        next["updatedAt"] = json!(e.at);
        if e.kind == Kind::Tool {
            next["live"] = e.item["label"].clone();
        }
        let ops = diff(&prev, &next);
        rows.insert(id.clone(), next);
        let mut batch = vec![(topic, "event", key, Change::Upsert { v: e.item.clone() })];
        if !ops.is_empty() {
            batch.push((Topic::list(), "session", id, Change::Patch { ops }));
        }
        batches.push((e.at, batch));
    }
    (batches, start)
}

fn v2(evs: &[Ev], seconds: f64, open: impl Fn(u64) -> String) -> Run {
    let (batches, list) = change_rows(evs);
    let peer = PeerInfo {
        peer: "p".into(),
        name: "p".into(),
        build: "b".into(),
        version: "2".into(),
        proto_min: 2,
        proto_max: 2,
        plugins: vec![],
    };
    let mut server = SyncServer::new(SyncOptions::new(
        "E",
        peer,
        0,
        0,
        Box::new(|_: &u64, _: &Topic| true),
    ));
    let (mut bytes, mut frames, mut seq, mut changes, mut now) = (0u64, 0u64, 0u64, 0usize, 0u64);
    let carry = |server: &mut SyncServer<u64>,
                 outs: Vec<Output<u64>>,
                 now: u64,
                 seq: u64,
                 bytes: &mut u64,
                 frames: &mut u64| {
        let mut queue = outs;
        while !queue.is_empty() {
            let mut next = Vec::new();
            for o in queue {
                match o {
                    Output::Send { conn, frame, id } => {
                        *bytes += frame.len() as u64;
                        *frames += u64::from(id.is_some());
                        next.extend(server.handle(
                            Input::Drained {
                                conn,
                                buffered_bytes: 0,
                            },
                            now,
                        ));
                    }
                    Output::SnapshotRequest {
                        conn, topic, req, ..
                    } => {
                        let rows = if topic.as_str() == "list" {
                            list.clone()
                        } else {
                            vec![]
                        };
                        next.extend(server.handle(
                            Input::SnapshotRows(SnapshotAnswer {
                                conn,
                                topic,
                                req,
                                seq,
                                rows,
                                full: true,
                                deleted: vec![],
                                more: false,
                            }),
                            now,
                        ));
                    }
                    _ => {}
                }
            }
            queue = next;
        }
    };
    for c in 0..CLIENTS {
        let query = ConnectQuery {
            client_id: Some(format!("c{c}")),
            fresh: Some(open(c)),
            ..ConnectQuery::default()
        };
        let outs = server.handle(
            Input::Connect {
                conn: ConnId(c),
                caller: c,
                query,
            },
            now,
        );
        carry(&mut server, outs, now, seq, &mut bytes, &mut frames);
    }
    let at_start = bytes; // the first snapshots: v1 has its GET /api/sessions for that
    let cpu = Instant::now();
    let mut tick = 50;
    for (at, rows) in batches {
        while tick <= at {
            now = tick;
            let outs = server.handle(Input::Tick, now);
            carry(&mut server, outs, now, seq, &mut bytes, &mut frames);
            tick += 50;
        }
        now = at;
        let rows: Vec<ChangeRow> = rows
            .into_iter()
            .map(|(topic, entity, id, change)| {
                seq += 1;
                ChangeRow {
                    seq,
                    topic,
                    entity: entity.into(),
                    id,
                    change,
                    at: now,
                }
            })
            .collect();
        changes += rows.len();
        let outs = server.handle(Input::Committed { rows }, now);
        carry(&mut server, outs, now, seq, &mut bytes, &mut frames);
    }
    while (tick as f64) <= seconds * 1000.0 + 100.0 {
        now = tick;
        let outs = server.handle(Input::Tick, now);
        carry(&mut server, outs, now, seq, &mut bytes, &mut frames);
        tick += 50;
    }
    Run {
        bytes: bytes - at_start,
        frames,
        cpu_ms: cpu.elapsed().as_secs_f64() * 1000.0,
        changes,
    }
}

#[allow(clippy::cast_precision_loss)]
fn mb(n: u64) -> String {
    format!("{:.2} MB", n as f64 / 1e6)
}

#[allow(clippy::cast_precision_loss)]
fn main() {
    let seconds = arg("seconds", 120.0);
    let mut r = Lcg(arg("seed", 1.0));
    let evs = workload(&mut r, seconds);
    let a = v1(&evs);
    let list_only = v2(&evs, seconds, |_| "list".into());
    let one_open = v2(&evs, seconds, |c| format!("list,session:s-{c}"));
    let summary_len = serde_json::to_string(&summary(0, 0, "x")).map_or(0, |s| s.len());
    println!(
        "G3 (Rust): {CLIENTS} clients, {TASKS} running tasks, {seconds} s, {} harness events (summary row {summary_len} B)",
        evs.len()
    );
    println!(
        "v1 broadcast            {:>9}  {:>6} frames  cpu {:>5.1} ms",
        mb(a.bytes),
        a.frames,
        a.cpu_ms
    );
    for (name, x) in [
        ("v2 list only", &list_only),
        ("v2 list + 1 open task", &one_open),
    ] {
        println!(
            "{name:<23} {:>9}  {:>6} frames  cpu {:>5.1} ms  {:.1}× fewer bytes  ({} change rows)",
            mb(x.bytes),
            x.frames,
            x.cpu_ms,
            a.bytes as f64 / x.bytes as f64,
            x.changes
        );
    }
    let pass = a.bytes as f64 / one_open.bytes as f64 >= 5.0 && one_open.cpu_ms <= a.cpu_ms;
    println!(
        "{}",
        if pass {
            "PASS: ≥ 5× fewer bytes and no more CPU than v1, with a task open on every client"
        } else {
            "FAIL"
        }
    );
    std::process::exit(i32::from(!pass));
}
