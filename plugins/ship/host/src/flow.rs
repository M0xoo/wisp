//! Task-level Ship it: every repo of a task shipped and merged in order, `wisp_pr` attach/detach, the PR
//! panel, and what GET /ship shows.

use futures::future::join_all;
use serde_json::{Value, json};
use wisp_kernel::Call;
use wisp_ship_api::{
    Attached, Draft, Merged, PrMore, PrPanel, PrSummary, RepoView, ShipTask, Shipped, Synced,
};
use wisp_ship_core::decide::{self, NO_TREE, Refusal, prs_of, ship_todo, shipping_start};
use wisp_ship_core::text::{
    LOG_LINES, across_note, attach_text, check_log_job, detach_text, log_tail, repo_of_url,
};

use crate::error::{Result, ShipError};
use crate::ops::{ShipReq, Shipper};
use crate::ship::{Out, Ship};

pub const STILL_WORKING: &str = "Still working: wait for it to finish, or stop it.";
pub const ALREADY_SHIPPING: &str = "Already shipping: wait for it to land.";

impl Ship {
    pub(crate) async fn statuses(
        &self,
        call: &Call,
        task: &ShipTask,
    ) -> Vec<wisp_ship_api::RepoStatus> {
        let all = task
            .repos
            .iter()
            .map(|r| self.shipper.status(call, &r.worktree, r.pr.as_ref()));
        join_all(all)
            .await
            .into_iter()
            .map(Result::unwrap_or_default)
            .collect()
    }

    /// Ship it: commit, push and open (or update) the PR in each repo with something new. One repo ships
    /// even with nothing new (git says why); a failure names its repo and leaves PRs already opened.
    pub async fn ship_all(
        &self,
        call: &Call,
        session: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<Shipped> {
        let mut task = self.task(session)?;
        if task.repos.is_empty() {
            return Err(Refusal::Invalid(NO_TREE.into()).into());
        }
        if self.tasks.is_live(session) {
            return Err(Refusal::Conflict(STILL_WORKING.into()).into());
        }
        if task.shipping.is_some() {
            return Err(Refusal::Conflict(ALREADY_SHIPPING.into()).into());
        }
        let statuses = if task.repos.len() > 1 {
            self.statuses(call, &task).await
        } else {
            Vec::new()
        };
        let todo = ship_todo(&statuses, &task.repos)?;
        let names: Vec<&str> = task.repos.iter().map(|r| r.name.as_str()).collect();
        let note = if names.len() > 1 {
            across_note(&names)
        } else {
            String::new()
        };
        let body = format!("{body}{note}").trim().to_owned();
        task.shipping = Some(shipping_start(&task, &todo, self.shipper.now()));
        self.save(task.clone());
        self.emit(Out::Step {
            session: session.into(),
            shipping: task.shipping.clone(),
        });
        let result = self
            .ship_each(call, &task, &todo, title, &body, draft)
            .await;
        let mut task = self.task(session)?;
        task.shipping = None;
        if result.is_ok() {
            task.pushed_at = self.shipper.now(); // polled fast for a while, so its checks show as they start
        }
        self.save(task.clone());
        self.emit(Out::Step {
            session: session.into(),
            shipping: None,
        });
        let prs = result?;
        self.recheck(call, session, false).await.ok();
        let task = self.task(session)?;
        let pr = task
            .pr()
            .cloned()
            .or_else(|| prs.first().map(|(_, p)| p.clone()))
            .unwrap_or_default();
        Ok(Shipped {
            pr,
            prs: (task.repos.len() > 1).then(|| prs_of(&task)),
        })
    }

    async fn ship_each(
        &self,
        call: &Call,
        task: &ShipTask,
        todo: &[usize],
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<Vec<(usize, PrSummary)>> {
        let mut out = Vec::new();
        for (k, &i) in todo.iter().enumerate() {
            let r = &task.repos[i];
            let several = todo.len() > 1;
            let on_step = |step: &str| {
                let id = task.session.clone();
                let shipping = self.tasks.update(&id, |t| {
                    if let Some(s) = t.shipping.as_mut() {
                        step.clone_into(&mut s.step);
                        if several {
                            s.repo = Some(r.name.clone());
                            s.at = u32::try_from(k + 1).ok();
                        }
                    }
                    t.shipping.clone()
                });
                self.emit(Out::Step {
                    session: id,
                    shipping: shipping.flatten(),
                });
            };
            let req = ShipReq {
                title,
                body,
                draft,
                pr: r.pr.as_ref(),
            };
            let pr = self
                .shipper
                .ship(call, &r.worktree, &req, &on_step)
                .await
                .map_err(|e| e.in_repo(&r.name, task.repos.len()))?;
            // kept at once: a later repo's failure leaves the PRs already opened in place
            let opened =
                r.pr.as_ref()
                    .is_none_or(|p| p.number != pr.number || !p.is_open());
            self.tasks
                .update(&task.session, |t| t.repos[i].pr = Some(pr.clone()));
            if opened {
                self.emit(Out::PrOpened {
                    session: task.session.clone(),
                    repo: r.name.clone(),
                    pr: pr.clone(),
                });
            }
            out.push((i, pr));
        }
        Ok(out)
    }

    /// Merge: squash-merge each open PR of the task, its own first; stops at the first that fails. An
    /// attached PR is merged on GitHub with nothing to sync.
    pub async fn merge_all(&self, call: &Call, session: &str) -> Result<Merged> {
        let mut task = self.task(session)?;
        let own: Vec<usize> = (0..task.repos.len())
            .filter(|&i| task.repos[i].pr.as_ref().is_some_and(PrSummary::is_open))
            .collect();
        let attached: Vec<usize> = (0..task.prs.len())
            .filter(|&i| task.prs[i].pr.is_open())
            .collect();
        let n = own.len() + attached.len();
        if n == 0 {
            return Err(Refusal::Invalid("No pull request to merge.".into()).into());
        }
        let mut synced = Vec::new();
        for i in own {
            let (wt, number, name) = (
                task.repos[i].worktree.clone(),
                task.repos[i].pr.as_ref().map_or(0, |p| p.number),
                task.repos[i].name.clone(),
            );
            match self.shipper.merge(call, &wt, number).await {
                Ok((pr, sync)) => (task.repos[i].pr, ()) = (Some(pr), synced.push(sync)),
                Err(e) => return Err(self.merge_failed(task, e.in_repo(&name, n))),
            }
        }
        let dir = Self::gh_dir(&task).await;
        for i in attached {
            let (url, name) = (task.prs[i].pr.url.clone(), task.prs[i].repo.clone());
            match self.shipper.merge_url(&dir, &url).await {
                Ok(pr) => task.prs[i].pr = pr,
                Err(e) => return Err(self.merge_failed(task, e.in_repo(&name, n))),
            }
        }
        let sync = Synced {
            ok: synced.iter().all(|s| s.ok),
            text: synced
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        };
        let prs = prs_of(&task);
        let pr = task
            .pr()
            .cloned()
            .or_else(|| task.prs.first().map(|x| x.pr.clone()))
            .unwrap_or_default();
        self.save(task);
        self.emit(Out::Merged {
            session: session.into(),
            prs: prs.clone(),
            sync: sync.clone(),
        });
        Ok(Merged {
            pr,
            sync,
            prs: (prs.len() > 1).then_some(prs),
        })
    }

    fn merge_failed(&self, task: ShipTask, e: ShipError) -> ShipError {
        self.save(task); // what merged before the failure stays merged
        e
    }

    /// `wisp_pr`: attach a PR (URL, or number in the task's repo). The PR of the task's own branch becomes
    /// the one Ship it pushes to; any other joins `prs`. `remove` detaches one.
    pub async fn attach(
        &self,
        call: &Call,
        session: &str,
        pr_ref: &str,
        remove: bool,
    ) -> Result<Attached> {
        let mut task = self.task(session)?;
        let r = decide::normalize_ref(pr_ref)?;
        if remove {
            let pr = decide::detach(&mut task, &r)?;
            self.save(task);
            return Ok(Attached {
                text: detach_text(&pr),
                pr,
                own: false,
            });
        }
        let dir = Self::gh_dir(&task).await;
        let pr = self
            .shipper
            .gh
            .pr_view(&dir, &r, self.shipper.now())
            .await
            .map_err(|e| {
                Refusal::Invalid(
                    format!("gh could not read that PR: {e}")
                        .chars()
                        .take(300)
                        .collect(),
                )
            })?;
        let repo = Some(repo_of_url(&pr.url))
            .filter(|s| !s.is_empty())
            .or_else(|| task.repos.first().map(|r| r.name.clone()))
            .unwrap_or_default();
        let own = decide::attach(&mut task, pr.clone(), repo)?;
        task.pushed_at = self.shipper.now(); // followed closely for a while
        let text = attach_text(&pr, own, prs_of(&task).len());
        self.save(task);
        self.recheck(call, session, false).await.ok();
        Ok(Attached { pr, own, text })
    }

    /// The PR panel: every PR of the task in full, its own first. Reading them refreshes the card; a PR
    /// gh can't read says why on its own.
    pub async fn details(&self, session: &str) -> Result<Vec<PrPanel>> {
        let mut task = self.task(session)?;
        let gh_dir = Self::gh_dir(&task).await;
        let mut jobs = Vec::new();
        for r in task.repos.iter().filter(|r| r.pr.is_some()) {
            let pr = r.pr.clone().unwrap_or_default();
            jobs.push((
                r.name.clone(),
                Shipper::dir_of(&r.worktree).await,
                pr.number.to_string(),
                pr,
            ));
        }
        jobs.extend(task.prs.iter().map(|x| {
            (
                x.repo.clone(),
                gh_dir.clone(),
                x.pr.url.clone(),
                x.pr.clone(),
            )
        }));
        let now = self.shipper.now();
        let got = join_all(
            jobs.iter()
                .map(|(_, dir, r, _)| self.shipper.gh.pr_detail(dir, r, now)),
        )
        .await;
        let mut changed = false;
        let mut out = Vec::new();
        for ((repo, _, _, prev), got) in jobs.into_iter().zip(got) {
            match got {
                Ok(d) => {
                    changed |= PrSummary {
                        checked_at: 0,
                        ..d.pr.clone()
                    } != PrSummary {
                        checked_at: 0,
                        ..prev.clone()
                    };
                    set_pr(&mut task, &prev, d.pr.clone());
                    out.push(PrPanel {
                        repo,
                        pr: d.pr,
                        more: Some(d.more),
                        error: None,
                    });
                }
                Err(e) => out.push(PrPanel {
                    repo,
                    pr: prev,
                    more: None::<PrMore>,
                    error: Some(e.to_string()),
                }),
            }
        }
        if changed {
            self.save(task);
        }
        Ok(out)
    }

    /// GET /sessions/:id/ship: each repo's branch and status; the first repo's at the top level, sums
    /// when there are several, and the draft message.
    pub async fn view(&self, call: &Call, session: &str, draft: &Draft) -> Result<Value> {
        let task = self.task(session)?;
        if task.repos.is_empty() {
            return Err(Refusal::Invalid(NO_TREE.into()).into());
        }
        self.recheck(call, session, true).await.ok();
        let sts = self.statuses(call, &task).await;
        let repos: Vec<RepoView> = task
            .repos
            .iter()
            .zip(sts)
            .map(|(r, status)| RepoView {
                repo: r.name.clone(),
                branch: r.worktree.branch.clone(),
                base: r.worktree.base.clone(),
                remote: r.worktree.remote.clone(),
                status,
                pr: r.pr.clone(),
            })
            .collect();
        let mut v = serde_json::to_value(&repos[0]).map_err(|e| ShipError::Gh(e.to_string()))?;
        if repos.len() > 1 {
            v["dirty"] = json!(repos.iter().map(|r| r.status.dirty).sum::<u32>());
            v["ahead"] = json!(repos.iter().map(|r| r.status.ahead).sum::<u32>());
            v["repos"] = serde_json::to_value(&repos).unwrap_or(Value::Null);
        }
        v["title"] = json!(draft.title);
        v["body"] = json!(draft.body);
        Ok(v)
    }

    /// A failing Actions job's log tail; "" for any other link (the agent looks at it).
    pub async fn check_log(&self, session: &str, url: &str) -> Result<String> {
        let task = self.task(session)?;
        let Some((owner, repo, job)) = check_log_job(url) else {
            return Ok(String::new());
        };
        let out = self
            .shipper
            .gh
            .job_log(&Self::gh_dir(&task).await, &owner, &repo, &job)
            .await;
        Ok(log_tail(&out, LOG_LINES))
    }
}

/// Puts a fresh copy of `prev` wherever the task holds it.
pub(crate) fn set_pr(task: &mut ShipTask, prev: &PrSummary, pr: PrSummary) {
    if let Some(r) = task.repos.iter_mut().find(|r| {
        r.pr.as_ref()
            .is_some_and(|p| p.url == prev.url && p.number == prev.number)
    }) {
        r.pr = Some(pr);
    } else if let Some(x) = task.prs.iter_mut().find(|x| x.pr.url == prev.url) {
        x.pr = pr;
    }
}
