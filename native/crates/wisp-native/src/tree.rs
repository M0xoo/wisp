//! Killing a process and everything it started, leaving 0 orphans (gate G12).
//!
//! Unix: every child starts as the leader of its own process group (setsid for a PTY,
//! `process_group(0)` otherwise), so one killpg reaches the tree. A grandchild that left the group
//! (setsid, a daemon) is found by walking parent links in a snapshot of the process table taken
//! before anything dies. Windows: the child's Job Object holds the tree; `TerminateJobObject` ends it.

use std::collections::BTreeSet;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::sync::Arc;

use wisp_native_sys as sys;

const POLL: Duration = Duration::from_millis(10);
/// How long SIGKILL gets to take effect before the rest counts as survivors.
const KILL_WAIT: Duration = Duration::from_secs(2);

/// What a kill reaches: the root pid and, on Windows, its job.
#[derive(Debug, Clone)]
pub struct Tree {
    pub root: u32,
    #[cfg(windows)]
    pub job: Option<Arc<sys::Job>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub signalled: usize,
    pub survivors: usize,
}

/// Signal `sig` to the tree (or only its root) and return at once.
pub fn signal(tree: &Tree, root_alive: bool, sig: i32, whole: bool) -> std::io::Result<()> {
    imp::signal(tree, root_alive, sig, whole)
}

/// Send `sig`, give the tree `grace` to go, SIGKILL what is left, and wait for it to be gone.
pub fn kill(tree: &Tree, root_alive: bool, sig: i32, grace: Duration) -> Report {
    imp::kill(tree, root_alive, sig, grace)
}

/// Poll `left` until it returns 0 or `limit` passes; returns the last count.
fn wait_until_gone(limit: Duration, mut left: impl FnMut() -> usize) -> usize {
    let end = Instant::now() + limit;
    loop {
        let n = left();
        if n == 0 || Instant::now() >= end {
            return n;
        }
        thread::sleep(POLL);
    }
}

#[cfg(unix)]
mod imp {
    use super::{BTreeSet, Duration, KILL_WAIT, Report, Tree, sys, wait_until_gone};

    /// The tree's live pids: the group, the root while it runs, and their descendants.
    pub(super) fn members(tree: &Tree, root_alive: bool, table: &[sys::ProcInfo]) -> BTreeSet<u32> {
        let live = || table.iter().filter(|p| !p.zombie);
        // An exited root's pid may belong to a stranger by now; its group id can't (a pgid is
        // not reused while the group has members), so only the group seeds the walk then.
        let mut set: BTreeSet<u32> =
            live().filter(|p| p.pgid == tree.root || (root_alive && p.pid == tree.root)).map(|p| p.pid).collect();
        loop {
            let before = set.len();
            let children: Vec<u32> = live().filter(|p| set.contains(&p.ppid)).map(|p| p.pid).collect();
            set.extend(children);
            if set.len() == before {
                break;
            }
        }
        set.remove(&std::process::id());
        set.retain(|&p| p > 1);
        set
    }

    fn snapshot(tree: &Tree, root_alive: bool) -> BTreeSet<u32> {
        match sys::processes() {
            Ok(table) => members(tree, root_alive, &table),
            Err(e) => {
                // No table (an unusual Unix): the group is all we can reach.
                tracing::warn!(error = %e, "process table unavailable");
                BTreeSet::new()
            }
        }
    }

    fn alive(pids: &BTreeSet<u32>) -> BTreeSet<u32> {
        let Ok(table) = sys::processes() else { return BTreeSet::new() };
        table.iter().filter(|p| !p.zombie && pids.contains(&p.pid)).map(|p| p.pid).collect()
    }

    fn send(tree: &Tree, pids: &BTreeSet<u32>, sig: i32) {
        // ESRCH (already gone) is the expected outcome for most of these.
        let _ = sys::signal_group(tree.root, sig);
        for &pid in pids {
            let _ = sys::signal_pid(pid, sig);
        }
    }

    pub(super) fn signal(tree: &Tree, root_alive: bool, sig: i32, whole: bool) -> std::io::Result<()> {
        if !whole {
            return sys::signal_pid(tree.root, sig);
        }
        send(tree, &snapshot(tree, root_alive), sig);
        Ok(())
    }

    pub(super) fn kill(tree: &Tree, root_alive: bool, sig: i32, grace: Duration) -> Report {
        let first = snapshot(tree, root_alive);
        let signalled = first.len();
        let left = |seen: &BTreeSet<u32>| {
            let mut now = snapshot(tree, false);
            now.extend(alive(seen));
            now
        };
        if sig != sys::SIGKILL {
            send(tree, &first, sig);
            // SIGCONT so a stopped process can act on the signal instead of waiting for SIGKILL.
            send(tree, &first, sys::SIGCONT);
            wait_until_gone(grace, || left(&first).len());
        }
        let mut seen = first;
        // Processes forked while the tree was dying are new members: walk again each round.
        let survivors = wait_until_gone(KILL_WAIT, || {
            let now = left(&seen);
            send(tree, &now, sys::SIGKILL);
            seen.extend(now.iter().copied());
            now.len()
        });
        Report { signalled, survivors }
    }
}

#[cfg(windows)]
mod imp {
    use super::{BTreeSet, Duration, KILL_WAIT, Report, Tree, sys, wait_until_gone};

    fn descendants(root: u32) -> BTreeSet<u32> {
        let Ok(table) = sys::processes() else { return BTreeSet::from([root]) };
        let mut set = BTreeSet::from([root]);
        loop {
            let before = set.len();
            let kids: Vec<u32> = table.iter().filter(|p| set.contains(&p.ppid)).map(|p| p.pid).collect();
            set.extend(kids);
            if set.len() == before {
                return set;
            }
        }
    }

    pub(super) fn signal(tree: &Tree, root_alive: bool, sig: i32, whole: bool) -> std::io::Result<()> {
        // Windows has no signals to deliver; every one that may end a process ends it.
        if sig == sys::SIGKILL || sig == sys::SIGTERM || sig == sys::SIGHUP {
            match (&tree.job, whole) {
                (Some(job), true) => return job.terminate(1),
                _ if root_alive => return sys::terminate_pid(tree.root, 1),
                _ => return Ok(()),
            }
        }
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
    }

    pub(super) fn kill(tree: &Tree, root_alive: bool, _sig: i32, _grace: Duration) -> Report {
        if let Some(job) = &tree.job {
            let signalled = job.active().map_or(0, |n| n as usize);
            let _ = job.terminate(1);
            let survivors = wait_until_gone(KILL_WAIT, || job.active().map_or(0, |n| n as usize));
            return Report { signalled, survivors };
        }
        // Not in a job (it couldn't be assigned): v1's taskkill /T, by hand.
        if !root_alive {
            return Report { signalled: 0, survivors: 0 };
        }
        let pids = descendants(tree.root);
        for &pid in &pids {
            let _ = sys::terminate_pid(pid, 1);
        }
        let survivors = wait_until_gone(KILL_WAIT, || {
            let Ok(table) = sys::processes() else { return 0 };
            table.iter().filter(|p| pids.contains(&p.pid)).count()
        });
        Report { signalled: pids.len(), survivors }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, pgid: u32) -> sys::ProcInfo {
        sys::ProcInfo { pid, ppid, pgid, zombie: false }
    }

    #[test]
    fn members_follow_the_group_and_parent_links() {
        let tree = Tree { root: 100 };
        let table = [
            p(100, 50, 100),
            p(101, 100, 100),
            p(102, 101, 102), // left the group (setsid): found through its parent
            p(103, 102, 103),
            p(200, 50, 200), // a stranger
            sys::ProcInfo { pid: 104, ppid: 100, pgid: 100, zombie: true },
        ];
        let got: Vec<u32> = imp::members(&tree, true, &table).into_iter().collect();
        assert_eq!(got, [100, 101, 102, 103]);
    }

    #[test]
    fn an_exited_root_pid_is_not_trusted() {
        let tree = Tree { root: 100 };
        // 100 was reused by a stranger in another group; 101 is our group's survivor.
        let table = [p(100, 1, 100_000), p(101, 1, 100)];
        let got: Vec<u32> = imp::members(&tree, false, &table).into_iter().collect();
        assert_eq!(got, [101]);
    }
}
