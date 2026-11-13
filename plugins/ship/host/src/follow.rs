//! Following a task's PRs: refreshing them (news makes the card unread), the conflict fix and its
//! push, rechecking what is left to ship, the minute poll and the boot drain.
//!
//! size-ok: the refresh, conflict fix and poll share the per-task follow state

use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures::future::join_all;
use wisp_kernel::{BoxFuture, Call};
use wisp_ship_api::{ConflictFix, PrSummary, Shipping, ToShip};
use wisp_ship_core::decide::to_ship;
use wisp_ship_core::follow::{self, Fix, after_restart, clear_fix, conflict_free, fix_ended, fix_started, is_also_news, is_news};
use wisp_ship_core::recheck::{BOOT_CHECKS, BOOT_PAUSE_MS, Begin, BootTask, boot_order};
use wisp_ship_core::text::{conflict_prompt, fix_title};

use crate::error::Result;
use crate::flow::set_pr;
use crate::ops::{ShipReq, Shipper};
use crate::ship::{Out, Ship};

/// How a fix-up turn ended (runtime's turn.finished).
#[derive(Debug, Clone, Default)]
pub struct TurnEnd {
    pub interrupted: bool,
    /// follow-ups still queued: the task moved on
    pub queued: bool,
    pub error: Option<String>,
}

impl Ship {
    /// The PRs of the task's other repos and those attached: their state, checks and reviews.
    async fn refresh_also(&self, session: &str) -> Result<()> {
        let task = self.task(session)?;
        let gh_dir = Self::gh_dir(&task).await;
        let mut open = Vec::new();
        for r in task.repos.iter().skip(1).filter(|r| r.pr.as_ref().is_some_and(PrSummary::is_open)) {
            let pr = r.pr.clone().unwrap_or_default();
            open.push((Shipper::dir_of(&r.worktree).await, pr.number.to_string(), pr));
        }
        open.extend(task.prs.iter().filter(|x| x.pr.is_open()).map(|x| (gh_dir.clone(), x.pr.url.clone(), x.pr.clone())));
        if open.is_empty() {
            return Ok(());
        }
        let now = self.shipper.now();
        let got = join_all(open.iter().map(|(dir, r, _)| self.shipper.gh.pr_view(dir, r, now))).await;
        let mut task = self.task(session)?;
        for ((_, _, prev), pr) in open.into_iter().zip(got) {
            let pr = pr.unwrap_or_else(|_| PrSummary { checked_at: now, ..prev.clone() });
            let news = is_also_news(&prev, &pr);
            set_pr(&mut task, &prev, pr.clone());
            self.emit(Out::PrChanged { session: session.into(), pr, news });
        }
        self.save(task);
        Ok(())
    }

    /// Refreshes the task's PRs from GitHub; its own PR (else the first other one).
    pub async fn refresh(&self, call: &Call, session: &str) -> Result<Option<PrSummary>> {
        self.refresh_also(session).await?;
        let task = self.task(session)?;
        let Some((prev, wt)) = task.repos.first().and_then(|r| r.pr.clone().map(|p| (p, r.worktree.clone()))) else {
            let other = task.repos.iter().find_map(|r| r.pr.clone()).or_else(|| task.prs.first().map(|x| x.pr.clone()));
            return Ok(other);
        };
        let pr = self.shipper.gh.pr_view(&Shipper::dir_of(&wt).await, &prev.number.to_string(), self.shipper.now()).await?;
        let mut task = self.task(session)?;
        task.repos[0].pr = Some(pr.clone());
        clear_fix(&mut task);
        self.save(task);
        self.emit(Out::PrChanged { session: session.into(), pr: pr.clone(), news: is_news(&prev, &pr) });
        self.fix_conflicts(call, session, false).await.ok();
        Ok(Some(pr))
    }

    /// Sends the task a follow-up to merge its base in, when the user asked (force) or Auto-fix is on.
    pub async fn fix_conflicts(&self, call: &Call, session: &str, force: bool) -> Result<Option<ConflictFix>> {
        let task = self.task(session)?;
        match follow::should_fix(&task, self.auto_fix(), force, self.tasks.busy(&task, self.is_starting(session))) {
            Fix::Skip => return Ok(None),
            Fix::Start => {}
            Fix::CheckBase => {
                self.starting(session, true);
                let base = self.shipper.conflicts_with_base(call, &task.repos[0].worktree).await;
                self.starting(session, false);
                if conflict_free(base.ok().flatten()) || self.tasks.is_live(session) {
                    return Ok(None);
                }
            }
        }
        let mut task = self.task(session)?;
        let fix = fix_started(&task, self.shipper.now());
        task.conflict_fix = Some(fix.clone());
        let prompt = task.pr().map(|pr| conflict_prompt(pr, &task.repos[0].worktree)).unwrap_or_default();
        self.save(task);
        self.emit(Out::FollowUp { session: session.into(), prompt });
        self.emit(Out::Fix { session: session.into(), fix: fix.clone() });
        Ok(Some(fix))
    }

    fn fail_fix(&self, session: &str, why: String) {
        let fix = self.tasks.update(session, |t| {
            let f = t.conflict_fix.get_or_insert_with(ConflictFix::default);
            f.step = "failed".into();
            f.why = Some(why);
            f.clone()
        });
        if let Some(fix) = fix {
            self.emit(Out::Fix { session: session.into(), fix });
        }
    }

    /// The fix-up turn ended: push it to the PR if the base really is merged in, else leave the task
    /// for the user with why.
    pub async fn finish_fix(&self, call: &Call, session: &str, end: TurnEnd) -> Result<()> {
        let mut task = self.task(session)?;
        if task.conflict_fix.as_ref().is_none_or(|f| f.step != "fixing") {
            return Ok(());
        }
        if let Some(why) = fix_ended(end.interrupted, end.queued, end.error.as_deref()) {
            self.fail_fix(session, why);
            return Ok(());
        }
        let wt = task.repos[0].worktree.clone();
        if let Err(why) = self.shipper.base_merged(call, &wt).await.unwrap_or_else(|e| Err(e.to_string())) {
            self.fail_fix(session, why);
            return Ok(());
        }
        if let Some(f) = task.conflict_fix.as_mut() {
            f.step = "pushing".into();
        }
        task.shipping = Some(Shipping { step: "start".into(), update: true, started_at: self.shipper.now(), ..Shipping::default() });
        self.save(task.clone());
        let on_step = |step: &str| {
            let shipping = self
                .tasks
                .update(session, |t| {
                    t.shipping.as_mut().map(|s| {
                        step.clone_into(&mut s.step);
                        s.clone()
                    })
                })
                .flatten();
            self.emit(Out::Step { session: session.into(), shipping });
        };
        let title = fix_title(&wt);
        let shipped =
            self.shipper.ship(call, &wt, &ShipReq { task: session, title: &title, body: "", draft: false, pr: task.pr() }, &on_step).await;
        let mut task = self.task(session)?;
        task.shipping = None;
        match shipped {
            Ok(pr) => {
                task.repos[0].pr = Some(pr);
                task.pushed_at = self.shipper.now();
                if let Some(f) = task.conflict_fix.as_mut() {
                    f.step = "done".into();
                }
                self.save(task);
            }
            Err(e) => {
                self.save(task);
                self.fail_fix(session, format!("Push failed: {e}"));
            }
        }
        self.recheck(call, session, false).await.ok();
        Ok(())
    }

    async fn check(&self, call: &Call, session: &str) -> Result<ToShip> {
        let task = self.task(session)?;
        let next = to_ship(&self.statuses(call, &task).await, &task.repos);
        let changed = self.tasks.update(session, |t| (t.to_ship != Some(next)).then(|| t.to_ship = Some(next)).is_some()).unwrap_or(false);
        if changed {
            self.emit(Out::ToShip { session: session.into(), to_ship: next });
        }
        Ok(next)
    }

    /// Rechecks what the task has to ship: one check at a time per task, one more if asked meanwhile.
    pub async fn recheck(&self, call: &Call, session: &str, lazy: bool) -> Result<Option<ToShip>> {
        let task = self.task(session)?;
        if task.repos.is_empty() || task.child {
            return Ok(None);
        }
        let begin = {
            self.gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner).begin(
                session,
                lazy,
                self.tasks.is_live(session),
                self.shipper.now(),
            )
        };
        if begin != Begin::Run {
            return Ok(task.to_ship);
        }
        loop {
            let got = self.check(call, session).await;
            let again = self.gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner).end(session);
            if !again {
                return got.map(Some);
            }
            let _ = self.gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner).begin(session, false, false, self.shipper.now());
        }
    }

    /// The 5 s tick: refreshes every task whose PR is due (fast while settling). One tick at a time.
    pub async fn poll(&self, call: &Call) {
        if self.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        let now = self.shipper.now();
        let due: Vec<String> = self.tasks.all().into_iter().filter(|t| follow::due(t, now)).map(|t| t.session).collect();
        join_all(due.iter().map(|id| self.refresh(call, id))).await;
        self.polling.store(false, Ordering::SeqCst);
    }

    /// After a restart: ships cut short end, then every open worktree task is rechecked, newest first,
    /// `BOOT_CHECKS` at a time with a pause between (`sleep` is the injected clock's).
    pub async fn boot(self: &Arc<Self>, call: &Call, sleep: Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>) {
        let mut seen = Vec::new();
        for mut t in self.tasks.all() {
            after_restart(&mut t);
            seen.push(BootTask {
                id: t.session.clone(),
                has_trees: !t.repos.is_empty(),
                child: t.child,
                archived: t.archived,
                merged: t.pr().is_some_and(PrSummary::is_merged),
                updated_at: t.updated_at,
            });
            self.tasks.put(t);
        }
        let me = self.clone();
        let call = call.clone();
        drain(boot_order(&seen), BOOT_CHECKS, BOOT_PAUSE_MS, sleep, move |id| {
            let (me, call) = (me.clone(), call.clone());
            Box::pin(async move {
                if me.tasks.get(&id).is_some() {
                    me.recheck(&call, &id, false).await.ok(); // not one deleted meanwhile
                }
            })
        })
        .await;
    }
}

/// `workers` lanes take ids from one queue in order, each pausing `pause_ms` after each.
pub async fn drain<F>(
    ids: Vec<String>,
    workers: usize,
    pause_ms: u64,
    sleep: Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>,
    run: F,
) where
    F: Fn(String) -> BoxFuture<'static, ()> + Send + Sync,
{
    let queue = std::sync::Mutex::new(std::collections::VecDeque::from(ids));
    let lane = || async {
        loop {
            let next = queue.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front();
            let Some(id) = next else { break };
            run(id).await;
            sleep(pause_ms).await;
        }
    };
    join_all((0..workers.max(1)).map(|_| lane())).await;
}
