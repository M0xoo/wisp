//! Following a PR: refresh, unpushed after a squash merge (edge case Git 6), conflict fixes, the
//! recheck gate and the boot drain (2 at a time, 20 ms apart).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use wisp_git_api::BaseMerged;
use wisp_kernel::BoxFuture;
use wisp_ship_api::{PrSummary, ToShip};

use super::h;
use crate::follow::{TurnEnd, drain};

type Sleep = Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>;

#[tokio::test]
async fn refresh_reads_checks_and_reviews() {
    let h = h();
    let wts = h.track("t", &[("repo", None)]);
    h.dirty(&wts[0], 1);
    h.ship.ship_all(&h.call, "t", "feat: x", "", false).await.unwrap_or_else(|e| panic!("{e}"));
    h.gh.lock().checks = Some(serde_json::json!([{ "conclusion": "SUCCESS" }, { "conclusion": "FAILURE" }, { "status": "IN_PROGRESS" }]));
    h.gh.lock().review = Some("APPROVED".into());
    let pr = h.ship.refresh(&h.call, "t").await.unwrap_or_else(|e| panic!("{e}")).unwrap_or_default();
    assert_eq!((pr.checks.pass, pr.checks.fail, pr.checks.pending), (1, 1, 1));
    assert_eq!(pr.review, "APPROVED");
    assert!(h.outs().iter().any(|o| matches!(o, crate::ship::Out::PrChanged { news: true, .. })));
}

/// Edge case Git 6: after a squash merge the branch stays ahead of the base for good, so unpushed
/// counts from the merged PR's head, else the remote branch, else ahead.
#[tokio::test]
async fn unpushed_after_a_squash_merge_counts_from_the_merged_head() {
    let h = h();
    let wts = h.track("t", &[("repo", None)]);
    h.git.lock().ahead.insert(wts[0].path.clone(), 3);
    let merged = PrSummary { state: "MERGED".into(), head: "mergedhead".into(), number: 1, ..PrSummary::default() };
    h.git.lock().counts.insert("mergedhead..HEAD".into(), Some(0));
    let st = h.ship.shipper.status(&h.call, &wts[0], Some(&merged)).await.unwrap_or_default();
    assert_eq!((st.ahead, st.unpushed), (3, 0), "nothing new since the merged head");
    h.git.lock().counts.insert("mergedhead..HEAD".into(), None);
    h.git.lock().pushed.insert(wts[0].path.clone(), 2);
    let st = h.ship.shipper.status(&h.call, &wts[0], Some(&merged)).await.unwrap_or_default();
    assert_eq!(st.unpushed, 1, "a merged head that's gone: the remote branch");
    h.git.lock().pushed.clear();
    let st = h.ship.shipper.status(&h.call, &wts[0], None).await.unwrap_or_default();
    assert_eq!(st.unpushed, 3, "never pushed: everything ahead");
}

#[tokio::test]
async fn recheck_publishes_what_changed_and_skips_running_tasks_when_lazy() {
    let h = h();
    let wts = h.track("t", &[("repo", None)]);
    h.dirty(&wts[0], 2);
    let got = h.ship.recheck(&h.call, "t", false).await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(got, Some(ToShip { dirty: 2, ahead: 0, unpushed: 0, repos: None }));
    assert_eq!(h.task("t").to_ship.map(|t| t.dirty), Some(2));
    h.dirty(&wts[0], 5);
    h.ship.tasks.set_live("t", true);
    let lazy = h.ship.recheck(&h.call, "t", true).await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(lazy.map(|t| t.dirty), Some(2), "a running task isn't rechecked lazily");
}

async fn conflicting(h: &super::H) {
    let wts = h.track("t", &[("repo", None)]);
    h.dirty(&wts[0], 1);
    h.ship.ship_all(&h.call, "t", "feat: x", "", false).await.unwrap_or_else(|e| panic!("{e}"));
    h.gh.lock().mergeable = Some("CONFLICTING".into());
    h.ship.refresh(&h.call, "t").await.unwrap_or_else(|e| panic!("{e}"));
}

#[tokio::test]
async fn fix_conflicts_sends_a_merge_follow_up_once_asked() {
    let h = h();
    conflicting(&h).await;
    assert!(h.follow_ups("t").is_empty(), "Auto-fix is off: only the user starts a fix");
    let fix = h.ship.fix_conflicts(&h.call, "t", true).await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(fix.map(|f| f.step), Some("fixing".into()));
    let prompts = h.follow_ups("t");
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("git merge origin/main") && prompts[0].contains("Don't rebase"));
}

#[tokio::test]
async fn a_finished_fix_with_markers_left_fails_with_why() {
    let h = h();
    conflicting(&h).await;
    h.ship.fix_conflicts(&h.call, "t", true).await.unwrap_or_else(|e| panic!("{e}"));
    h.git.lock().base_merged = Some(BaseMerged { ok: false, why: Some("Conflict markers left in a.js".into()) });
    h.ship.finish_fix(&h.call, "t", TurnEnd::default()).await.unwrap_or_else(|e| panic!("{e}"));
    let f = h.task("t").conflict_fix.unwrap_or_default();
    assert_eq!(f.step, "failed");
    assert!(f.why.unwrap_or_default().contains("Conflict markers"));
}

/// The boot recheck drains two at a time with a pause after each (v1: hundreds of tasks at once
/// spawned thousands of gits at boot).
#[tokio::test]
async fn drain_runs_two_lanes_in_order_with_a_pause_after_each() {
    let running = Arc::new(AtomicUsize::new(0));
    let most = Arc::new(AtomicUsize::new(0));
    let order = Arc::new(Mutex::new(Vec::new()));
    let pauses = Arc::new(Mutex::new(Vec::new()));
    let p = pauses.clone();
    let sleep: Sleep = Arc::new(move |ms| {
        p.lock().unwrap_or_else(PoisonError::into_inner).push(ms);
        Box::pin(tokio::task::yield_now())
    });
    let (r, m, o) = (running.clone(), most.clone(), order.clone());
    let ids: Vec<String> = (0..7).map(|i| format!("t{i}")).collect();
    drain(ids.clone(), 2, 20, sleep, move |id| {
        let (r, m, o) = (r.clone(), m.clone(), o.clone());
        Box::pin(async move {
            let now = r.fetch_add(1, Ordering::SeqCst) + 1;
            m.fetch_max(now, Ordering::SeqCst);
            o.lock().unwrap_or_else(PoisonError::into_inner).push(id);
            tokio::task::yield_now().await;
            r.fetch_sub(1, Ordering::SeqCst);
        })
    })
    .await;
    assert_eq!(most.load(Ordering::SeqCst), 2);
    assert_eq!(*order.lock().unwrap_or_else(PoisonError::into_inner), ids, "the queue's order (newest first)");
    assert_eq!(*pauses.lock().unwrap_or_else(PoisonError::into_inner), vec![20; 7]);
}

#[tokio::test]
async fn boot_ends_ships_cut_short_and_rechecks_open_tasks() {
    let h = h();
    let wts = h.track("t", &[("repo", None)]);
    h.dirty(&wts[0], 1);
    let mut task = h.task("t");
    task.shipping = Some(wisp_ship_api::Shipping { step: "push".into(), ..Default::default() });
    h.ship.tasks.put(task);
    let sleep: Sleep = Arc::new(|_| Box::pin(async {}));
    h.ship.boot(&h.call, sleep).await;
    let t = h.task("t");
    assert!(t.shipping.is_none());
    assert_eq!(t.to_ship.map(|x| x.dirty), Some(1));
}
