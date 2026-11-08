//! Helpers shared by the proc tests.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::panic,
    clippy::match_wild_err_arm,
    reason = "test helpers"
)]

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use wisp_proc::Output;

pub fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

/// Reads output until it holds `needle` (10 s at most); returns everything read.
pub async fn read_until(out: &mut mpsc::Receiver<Output>, needle: &str) -> String {
    let mut seen = Vec::new();
    let end = tokio::time::Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains(needle) {
        match tokio::time::timeout_at(end, out.recv()).await {
            Ok(Some(o)) => seen.extend(o.data),
            Ok(None) => break,
            Err(_) => panic!(
                "timed out waiting for {needle:?}; saw {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

/// The live members of `root`'s tree now: its group and every descendant (through parent links).
pub fn tree_of(root: u32) -> BTreeSet<u32> {
    let table = wisp_proc::processes().unwrap();
    let live: Vec<_> = table.iter().filter(|p| !p.zombie).collect();
    let mut set: BTreeSet<u32> = live
        .iter()
        .filter(|p| p.pid == root || p.pgid == root)
        .map(|p| p.pid)
        .collect();
    loop {
        let before = set.len();
        let kids: Vec<u32> = live
            .iter()
            .filter(|p| set.contains(&p.ppid))
            .map(|p| p.pid)
            .collect();
        set.extend(kids);
        if set.len() == before {
            return set;
        }
    }
}

/// Which of `pids` still run (zombies count as gone: they can't run).
pub fn still_alive(pids: &BTreeSet<u32>) -> Vec<u32> {
    let table = wisp_proc::processes().unwrap();
    table
        .iter()
        .filter(|p| !p.zombie && pids.contains(&p.pid))
        .map(|p| p.pid)
        .collect()
}

/// Every one of `pids` is gone within 3 s (an orphan reparented to init is reaped by it).
pub async fn assert_all_gone(pids: &BTreeSet<u32>) {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        let left = still_alive(pids);
        if left.is_empty() {
            return;
        }
        assert!(Instant::now() < end, "orphans left: {left:?} of {pids:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub mod sh {
    /// A tree that resists: two children in the group, one ignoring SIGTERM/SIGHUP/SIGINT (only SIGKILL
    /// ends it), one that left the group (setsid, found through its parent), one a level deeper.
    pub fn tree() -> String {
        [
            "sleep 300 &",
            "(trap '' TERM HUP INT; sleep 300) &",
            "perl -MPOSIX -e 'POSIX::setsid(); sleep 300' &",
            "sh -c 'sleep 300 & wait' &",
            "sleep 0.3; echo ready; wait",
        ]
        .join("\n")
    }
}
