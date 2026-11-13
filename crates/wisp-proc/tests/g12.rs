//! Gate G12 (plan §9.1): spawn and kill a tree with 0 orphans, 1,000 times. Each tree resists: a child
//! that ignores SIGTERM/SIGHUP/SIGINT, one that left the group (setsid), one two levels down. Half run
//! on a PTY, half on pipes, 8 at a time.
//!
//!   cargo test -p wisp-proc --test g12 -- --ignored --nocapture      # the gate: 1,000 runs
//!   cargo test -p wisp-proc --test g12                               # 40 runs, in every test run
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::panic, clippy::cast_precision_loss, reason = "a test")]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{args, read_until, still_alive, tree_of};
use tokio::sync::Semaphore;
use wisp_proc::{ExecOpts, Proc, PtySize, SpawnOpts};

/// The marker every G12 process carries, so a final `ps` finds any survivor wisp lost track of.
const MARK: &str = "4242";

fn tree() -> String {
    [
        format!("sleep {MARK} &"),
        format!("(trap '' TERM HUP INT; sleep {MARK}) &"),
        format!("perl -MPOSIX -e 'POSIX::setsid(); sleep {MARK}' &"),
        format!("sh -c 'sleep {MARK} & wait' &"),
        "sleep 0.05; echo ready; wait".to_owned(),
    ]
    .join("\n")
}

/// One run: start, wait until the whole tree is up, kill it, check every member is gone.
async fn one(proc: Proc, i: usize) -> (usize, usize) {
    let pty = i.is_multiple_of(2).then_some(PtySize { cols: 80, rows: 24 });
    let opts = SpawnOpts { pty, grace: Some(Duration::from_millis(50)), ..SpawnOpts::default() };
    let (h, mut out) = proc.spawn("sh", &args(&["-c", &tree()]), opts).unwrap().split();
    read_until(&mut out, "ready").await;
    let members = tree_of(h.pid());
    let report = h.kill().await;
    tokio::time::timeout(Duration::from_secs(5), h.exited()).await.unwrap();
    // An orphan reparented to init is reaped by it a moment later; a live one never goes.
    let end = Instant::now() + Duration::from_secs(2);
    let mut left = still_alive(&members);
    while !left.is_empty() && Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(10)).await;
        left = still_alive(&members);
    }
    assert!(members.len() >= 6, "run {i}: the tree didn't come up whole: {members:?}");
    (left.len() + report.survivors, members.len())
}

async fn gate(runs: usize) {
    let proc = wisp_proc::local();
    let slots = Arc::new(Semaphore::new(8));
    let start = Instant::now();
    let mut tasks = Vec::with_capacity(runs);
    for i in 0..runs {
        let (proc, slots) = (proc.clone(), slots.clone());
        tasks.push(tokio::spawn(async move {
            let _slot = slots.acquire_owned().await.unwrap();
            one(proc, i).await
        }));
    }
    let (mut orphans, mut processes) = (0, 0);
    for t in tasks {
        let (o, n) = t.await.unwrap();
        orphans += o;
        processes += n;
    }
    let ps = proc.exec("ps", &args(&["-axo", "command="]), ExecOpts::default()).await.unwrap();
    let marked: Vec<String> = ps.stdout_text().lines().filter(|l| l.contains(&format!("sleep {MARK}"))).map(str::to_owned).collect();
    let secs = start.elapsed().as_secs_f64();
    eprintln!(
        "G12: {runs} runs ({} on a PTY), {processes} processes killed, {orphans} orphans, {} marked left, {secs:.1} s ({:.1} ms/run)",
        runs.div_ceil(2),
        marked.len(),
        secs * 1000.0 / runs as f64
    );
    assert_eq!((orphans, marked.len()), (0, 0), "survivors: {marked:?}");
    assert_eq!(proc.live(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spawn_and_kill_tree_leaves_no_orphans() {
    gate(40).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "gate G12: 1,000 runs, about a minute"]
async fn g12_thousand_runs_zero_orphans() {
    gate(1000).await;
}
