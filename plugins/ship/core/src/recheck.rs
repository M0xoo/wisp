//! When to recheck what a task has to ship. One check at a time per task (one asked for meanwhile runs
//! right after); a lazy one (a card fetching its task) skips running tasks and runs at most every 5 s.
//! After a restart, tasks are checked newest first, two at a time with a 20 ms pause: hundreds of
//! worktree tasks checked at once spawned thousands of gits at boot and the page's first requests waited.

use std::collections::HashMap;

pub const SHIP_RECHECK_MS: i64 = 5_000;
/// Worktree checks at once after a restart.
pub const BOOT_CHECKS: usize = 2;
pub const BOOT_DELAY_MS: u64 = 1_500;
pub const BOOT_PAUSE_MS: u64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Begin {
    /// check now; call `end` after
    Run,
    /// one is under way: it runs once more when that ends
    Queued,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Checking,
    Again,
}

/// The per-task gate. Pure: the caller passes the time and whether the task is running.
#[derive(Debug, Default)]
pub struct CheckGate {
    checks: HashMap<String, Slot>,
    checked_at: HashMap<String, i64>,
}

impl CheckGate {
    pub fn begin(&mut self, id: &str, lazy: bool, live: bool, now: i64) -> Begin {
        let busy = self.checks.contains_key(id);
        if lazy
            && (live
                || busy
                || now - self.checked_at.get(id).copied().unwrap_or(i64::MIN / 2) < SHIP_RECHECK_MS)
        {
            return Begin::Skip;
        }
        if busy {
            self.checks.insert(id.to_owned(), Slot::Again);
            return Begin::Queued;
        }
        self.checks.insert(id.to_owned(), Slot::Checking);
        self.checked_at.insert(id.to_owned(), now);
        Begin::Run
    }

    /// The check ended: true when another was asked for meanwhile (run it now).
    pub fn end(&mut self, id: &str) -> bool {
        self.checks.remove(id) == Some(Slot::Again)
    }

    pub fn forget(&mut self, id: &str) {
        self.checks.remove(id);
        self.checked_at.remove(id);
    }
}

/// A task as the boot recheck sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootTask {
    pub id: String,
    pub has_trees: bool,
    pub child: bool,
    pub archived: bool,
    pub merged: bool,
    pub updated_at: i64,
}

/// Which tasks the boot recheck visits, newest first (they're the ones on screen).
pub fn boot_order(tasks: &[BootTask]) -> Vec<String> {
    let mut due: Vec<&BootTask> = tasks
        .iter()
        .filter(|t| t.has_trees && !t.child && !t.archived && !t.merged)
        .collect();
    due.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    due.into_iter().map(|t| t.id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_check_at_a_time_and_one_more_after() {
        let mut g = CheckGate::default();
        assert_eq!(g.begin("a", false, false, 0), Begin::Run);
        assert_eq!(g.begin("a", false, false, 1), Begin::Queued);
        assert_eq!(
            g.begin("a", false, false, 2),
            Begin::Queued,
            "many asks: one more run"
        );
        assert_eq!(
            g.begin("b", false, false, 2),
            Begin::Run,
            "tasks don't wait on each other"
        );
        assert!(g.end("a"));
        assert_eq!(g.begin("a", false, false, 3), Begin::Run);
        assert!(!g.end("a"));
    }

    #[test]
    fn lazy_skips_running_tasks_and_runs_at_most_every_five_seconds() {
        let mut g = CheckGate::default();
        assert_eq!(g.begin("a", true, true, 0), Begin::Skip, "running");
        assert_eq!(g.begin("a", true, false, 0), Begin::Run);
        assert_eq!(g.begin("a", true, false, 1), Begin::Skip, "under way");
        g.end("a");
        assert_eq!(g.begin("a", true, false, 4_999), Begin::Skip);
        assert_eq!(g.begin("a", true, false, 5_000), Begin::Run);
        g.end("a");
        assert_eq!(
            g.begin("a", false, true, 5_001),
            Begin::Run,
            "a non-lazy check ignores both"
        );
    }

    #[test]
    fn boot_visits_open_worktree_tasks_newest_first() {
        let t = |id: &str, at: i64| BootTask {
            id: id.into(),
            has_trees: true,
            updated_at: at,
            ..BootTask::default()
        };
        let tasks = [
            t("old", 1),
            t("new", 9),
            BootTask {
                archived: true,
                ..t("arch", 5)
            },
            BootTask {
                merged: true,
                ..t("merged", 6)
            },
            BootTask {
                has_trees: false,
                ..t("flat", 7)
            },
            BootTask {
                child: true,
                ..t("sub", 8)
            },
            t("mid", 5),
        ];
        assert_eq!(boot_order(&tasks), ["new", "mid", "old"]);
    }

    /// Property (model-based): whatever the interleaving, a task never has two checks running, and
    /// every ask made while one runs is answered by a run after it.
    #[test]
    fn the_gate_matches_its_model() {
        let mut seed: u64 = 5;
        for _ in 0..200 {
            let mut g = CheckGate::default();
            let mut running = [false; 3];
            let mut owed = [false; 3];
            for step in 0..60_i64 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let i = usize::try_from(seed % 3).unwrap_or(0);
                let id = ["a", "b", "c"][i];
                if seed & 8 == 0 && running[i] {
                    let again = g.end(id);
                    assert_eq!(again, owed[i]);
                    running[i] = false;
                    owed[i] = false;
                    if again {
                        assert_eq!(g.begin(id, false, false, step), Begin::Run);
                        running[i] = true;
                    }
                } else {
                    match g.begin(id, false, false, step) {
                        Begin::Run => {
                            assert!(!running[i]);
                            running[i] = true;
                        }
                        Begin::Queued => {
                            assert!(running[i]);
                            owed[i] = true;
                        }
                        Begin::Skip => unreachable!("non-lazy never skips"),
                    }
                }
            }
        }
    }
}
