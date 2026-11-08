//! v1 test/worktrees.test.js, as policy: each case is the decision the v1 test checked end to end.
//!
//! size-ok: a test file: one case per v1 test/worktrees.test.js case

use super::*;
use crate::testrand::Rng;

const NOW: i64 = 100 * DAY;

fn tree(path: &str, only: Option<Option<u32>>, touched: i64) -> TreeSnap {
    TreeSnap {
        path: path.into(),
        branch: format!("wisp/{path}"),
        on_disk: true,
        only,
        touched,
        size: Some(GB),
    }
}

fn task(id: &str, used: i64) -> TaskSnap {
    TaskSnap {
        id: id.into(),
        updated_at: used,
        created_at: used,
        trees: vec![tree(id, Some(Some(0)), used)],
        ..TaskSnap::default()
    }
}

fn policy(days: Option<i64>, max: Option<usize>) -> Policy {
    Policy {
        idle_days: days,
        clock_from: 0,
        max,
    }
}

#[test]
fn an_idle_clean_worktree_goes_after_the_days_set() {
    let p = policy(Some(7), None);
    let old = task("old", NOW - 8 * DAY);
    let fresh = task("fresh", NOW - 2 * DAY);
    assert_eq!(
        plan_sweep(&[old, fresh], &p, None, DiskLimits::default(), NOW),
        ["old"]
    );
}

#[test]
fn never_touched_dirty_off_branch_kept_parked_open_pr_in_use_unreadable() {
    let p = policy(Some(1), None);
    let old = NOW - 30 * DAY;
    let mut dirty = task("dirty", old);
    dirty.trees[0].only = Some(Some(2));
    let mut detached = task("detached", old);
    detached.trees[0].only = Some(Some(1)); // a commit off the branch counts as one
    let kept = TaskSnap {
        kept: true,
        ..task("kept", old)
    };
    let parked = TaskSnap {
        parked: true,
        ..task("parked", old)
    };
    let pr = TaskSnap {
        pr_open: true,
        ..task("pr", old)
    };
    let busy = TaskSnap {
        busy: true,
        ..task("busy", old)
    };
    let mut unreadable = task("unreadable", old);
    unreadable.trees[0].only = Some(None);
    let mut unlooked = task("unlooked", old);
    unlooked.trees[0].only = None;
    let all = [
        dirty, detached, kept, parked, pr, busy, unreadable, unlooked,
    ];
    let want = [
        Standing::Dirty,
        Standing::Dirty,
        Standing::Kept,
        Standing::Parked,
        Standing::Pr,
        Standing::Busy,
        Standing::Unreadable,
        Standing::Checking,
    ];
    for (s, w) in all.iter().zip(want) {
        assert_eq!(standing(s), w, "{}", s.id);
    }
    assert!(
        plan_sweep(
            &all,
            &p,
            Some(Disk {
                free: 0,
                total: 100
            }),
            DiskLimits::default(),
            NOW
        )
        .is_empty()
    );
    assert!(
        plan_sweep(
            &all,
            &policy(Some(1), Some(0)),
            None,
            DiskLimits::default(),
            NOW
        )
        .is_empty(),
        "even over the cap"
    );
}

#[test]
fn off_never_removes_and_the_default_waits_from_the_upgrade() {
    let old = [task("a", NOW - 30 * DAY)];
    assert!(
        plan_sweep(
            &old,
            &Policy::from_settings(Some("off"), Some("off"), 0),
            Some(Disk { free: 0, total: 1 }),
            DiskLimits::default(),
            NOW
        )
        .is_empty()
    );
    let upgraded = Policy::from_settings(None, None, NOW - DAY);
    assert!(
        plan_sweep(&old, &upgraded, None, DiskLimits::default(), NOW).is_empty(),
        "the clock starts at the upgrade"
    );
    assert_eq!(
        plan_sweep(&old, &upgraded, None, DiskLimits::default(), NOW + 7 * DAY),
        ["a"]
    );
    let chose = Policy::from_settings(Some("7"), None, NOW - DAY);
    assert_eq!(chose.clock_from, 0, "chosen: the task's own age counts");
}

#[test]
fn a_low_disk_takes_the_oldest_idle_first_and_stops_at_enough() {
    let p = policy(Some(30), None);
    let tasks = [
        task("c", NOW - 3 * DAY),
        task("a", NOW - 5 * DAY),
        task("b", NOW - 4 * DAY),
        task("new", NOW - HOUR),
    ];
    let limits = DiskLimits {
        low: 10 * GB,
        enough: 11 * GB,
    };
    let got = plan_sweep(
        &tasks,
        &p,
        Some(Disk {
            free: 9 * GB,
            total: 100 * GB,
        }),
        limits,
        NOW,
    );
    assert_eq!(
        got,
        ["a", "b"],
        "9 + 1 + 1 GB reaches enough; one used an hour ago never goes"
    );
}

#[test]
fn a_merged_or_closed_pr_goes_at_once_never_while_busy_or_dirty() {
    let p = policy(Some(30), None);
    let ended = TaskSnap {
        pr_ended: true,
        ..task("ended", NOW - HOUR)
    };
    let busy = TaskSnap {
        pr_ended: true,
        busy: true,
        ..task("busy", NOW - HOUR)
    };
    let mut dirty = TaskSnap {
        pr_ended: true,
        ..task("dirty", NOW - HOUR)
    };
    dirty.trees[0].only = Some(Some(1));
    assert_eq!(
        plan_sweep(&[ended, busy, dirty], &p, None, DiskLimits::default(), NOW),
        ["ended"]
    );
}

#[test]
fn a_done_task_goes_after_a_day_and_review_waits_its_days() {
    let p = policy(Some(7), None);
    let done = TaskSnap {
        done: true,
        ..task("done", NOW - 2 * DAY)
    };
    let review = task("review", NOW - 2 * DAY);
    assert_eq!(clean_at(&done, &p), Some(NOW - DAY));
    assert_eq!(
        plan_sweep(&[done, review], &p, None, DiskLimits::default(), NOW),
        ["done"]
    );
}

#[test]
fn over_the_cap_the_oldest_idle_go_until_it_fits() {
    let p = policy(Some(365), Some(2));
    let mut dirty = task("dirty", NOW - 50 * DAY);
    dirty.trees[0].only = Some(Some(1));
    let kept = TaskSnap {
        kept: true,
        ..task("kept", NOW - 40 * DAY)
    };
    let tasks = [
        dirty,
        kept,
        task("a", NOW - 30 * DAY),
        task("b", NOW - 20 * DAY),
        task("c", NOW - 10 * DAY),
        task("hot", NOW - 60_000),
    ];
    assert_eq!(
        plan_sweep(&tasks, &p, None, DiskLimits::default(), NOW),
        ["a", "b", "c"],
        "6 folders, cap 2: dirty, kept and the hot one stay even over it"
    );
}

#[test]
fn the_cap_off_or_not_reached_removes_nothing_and_a_new_folder_past_it_sweeps_later() {
    let tasks = [task("a", NOW - 30 * DAY), task("b", NOW - 30 * DAY)];
    assert!(
        plan_sweep(
            &tasks,
            &policy(None, None),
            None,
            DiskLimits::default(),
            NOW
        )
        .is_empty()
    );
    assert!(
        plan_sweep(
            &tasks,
            &policy(Some(365), Some(2)),
            None,
            DiskLimits::default(),
            NOW
        )
        .is_empty()
    );
    assert!(!past_cap(2, &policy(None, Some(2))));
    assert!(past_cap(3, &policy(None, Some(2))));
    assert!(!past_cap(100, &policy(None, None)));
}

#[test]
fn by_hand_clean_up_now_force_for_dirty_never_in_use() {
    let old = NOW - 3 * DAY;
    let mut dirty = task("dirty", old);
    dirty.trees[0].only = Some(Some(1));
    let busy = TaskSnap {
        busy: true,
        ..task("busy", old)
    };
    let tasks = [task("idle", old), dirty, busy, task("recent", NOW - HOUR)];
    let all = pick_clean(&tasks, None, &[], &[], false, NOW).unwrap();
    assert_eq!(
        all.jobs,
        [("idle".to_owned(), false)],
        "Clean up now: idle ones used over a day ago"
    );
    let ids = ["dirty".to_owned(), "busy".to_owned()];
    assert_eq!(
        pick_clean(&tasks, Some(&ids), &[], &[], false, NOW),
        Err(PickError::InUse)
    );
    let forced = pick_clean(&tasks, Some(&ids), &[], &[], true, NOW).unwrap();
    assert_eq!(
        (forced.jobs, forced.skipped),
        (vec![("dirty".to_owned(), true)], vec!["busy".to_owned()])
    );
}

#[test]
fn leftovers_only_by_name_and_only_folders_in_worktrees() {
    let known = ["left".to_owned()];
    assert!(
        pick_clean(&[], None, &known, &known, false, NOW)
            .unwrap()
            .jobs
            .is_empty(),
        "named leftovers don't pull in idle tasks"
    );
    for bad in ["../x", "a/b", "..", "", "other"] {
        assert!(
            matches!(
                pick_clean(&[], None, &[bad.to_owned()], &known, false, NOW),
                Err(PickError::NotALeftover(_))
            ),
            "{bad}"
        );
    }
}

#[test]
fn leftovers_dont_count_toward_the_cap() {
    // leftovers aren't TaskSnaps: two task folders under a cap of 2 stay, however many leftovers exist
    let tasks = [task("a", NOW - 30 * DAY), task("b", NOW - 30 * DAY)];
    assert!(
        plan_sweep(
            &tasks,
            &policy(Some(365), Some(2)),
            None,
            DiskLimits::default(),
            NOW
        )
        .is_empty()
    );
}

#[test]
fn sizes_looks_and_du() {
    let out = "4\t/w/a\n8\t/w/b\nbad line\n12\t/w\n";
    assert_eq!(
        parse_du(out, "/w"),
        [("/w/a".to_owned(), 4096), ("/w/b".to_owned(), 8192)]
    );
    assert!(
        !needs_look(Some((Some(0), 5, 7)), 5, 7),
        "nothing moved: the last look stands"
    );
    assert!(
        needs_look(Some((Some(0), 5, 7)), 6, 7),
        "the folder's mtime moved"
    );
    assert!(
        needs_look(Some((Some(0), 5, 7)), 5, 8),
        "its task ran since"
    );
    assert!(
        needs_look(Some((None, 5, 7)), 5, 7),
        "git couldn't tell last time"
    );
    assert!(needs_look(None, 5, 7));
    assert!(du_due(false, 0, NOW, true), "never sized: even when busy");
    assert!(!du_due(true, NOW - 1, NOW, true), "busy and sized: wait");
    assert!(du_due(false, NOW - DU_MS, NOW, false));
    assert!(!du_due(false, NOW - 1, NOW, false));
}

fn random_task(r: &mut Rng, i: u64) -> TaskSnap {
    let used = NOW
        - i64::try_from(r.below(40)).unwrap_or(0) * DAY
        - i64::try_from(r.below(24)).unwrap_or(0) * HOUR;
    let mut s = task(&format!("t{i}"), used);
    s.busy = r.below(5) == 0;
    s.kept = r.below(6) == 0;
    s.pr_open = r.below(6) == 0;
    s.pr_ended = r.below(4) == 0;
    s.done = r.bool();
    s.trees[0].only = match r.below(5) {
        0 => None,
        1 => Some(None),
        2 => Some(Some(1)),
        _ => Some(Some(0)),
    };
    s
}

#[test]
fn prop_the_sweep_only_ever_takes_idle_task_folders_and_honours_the_cap() {
    let mut r = Rng::new(23);
    for round in 0..400 {
        let n = r.below(12);
        let tasks: Vec<TaskSnap> = (0..n).map(|i| random_task(&mut r, i)).collect();
        let days = (r.below(3) > 0).then(|| i64::try_from(1 + r.below(10)).unwrap_or(1));
        let max = r.bool().then(|| usize::try_from(r.below(8)).unwrap_or(0));
        let p = Policy {
            idle_days: days,
            clock_from: 0,
            max,
        };
        let disk = r.bool().then(|| Disk {
            free: r.below(20) * GB,
            total: 100 * GB,
        });
        let got = plan_sweep(&tasks, &p, disk, DiskLimits::default(), NOW);
        let mut seen = std::collections::HashSet::new();
        for id in &got {
            assert!(seen.insert(id), "round {round}: {id} twice");
            let s = tasks.iter().find(|s| &s.id == id).unwrap();
            assert_eq!(
                standing(s),
                Standing::Idle,
                "round {round}: {id} isn't idle"
            );
        }
        if days.is_none() && max.is_none() {
            assert!(got.is_empty(), "off and no cap: nothing goes");
        }
    }
}

#[test]
fn free_disk_from_df() {
    let out =
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 100 40 60 40% /\n";
    assert_eq!(
        parse_df(out),
        Some(Disk {
            free: 60 * 1024,
            total: 100 * 1024
        })
    );
    assert_eq!(parse_df("garbage"), None);
}
