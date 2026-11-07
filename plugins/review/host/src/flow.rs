//! The review of one PR head: `maybe` decides (core's gate and pick), `run` gathers the head, the tests,
//! the diff and the reviewer's reply, and keeps the result on the task (v1 createReview).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::{Call, Result};
use wisp_review_api::{Pick, Review, ReviewFinished, Severity, Status, TestsRun};
use wisp_review_core::{self as core, Decision, Due, Finish, Gate, Outcome, PromptInput};

use crate::ports::{Env, Fut, Task};

/// How long the reviewer may take.
pub const REVIEW_MS: u64 = 6 * 60_000;

/// What `maybe` did: why it didn't start ("" when it did, or one is running for this head), and the
/// run to spawn on the plugin's scope.
pub struct Started {
    pub why: String,
    pub job: Option<Fut<()>>,
}

impl std::fmt::Debug for Started {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Started").field("why", &self.why).field("job", &self.job.is_some()).finish()
    }
}

pub struct Reviewer {
    env: Arc<dyn Env>,
    /// session id → the head being reviewed
    running: Mutex<HashMap<String, String>>,
}

impl std::fmt::Debug for Reviewer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reviewer").field("running", &self.lock().len()).finish_non_exhaustive()
    }
}

impl Reviewer {
    pub fn new(env: Arc<dyn Env>) -> Arc<Self> {
        Arc::new(Self { env, running: Mutex::new(HashMap::new()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.lock().contains_key(id)
    }

    /// Start a review of the task's PR head when one is due. `force`: Review again, or the first by hand.
    pub async fn maybe(self: &Arc<Self>, call: &Call, id: &str, force: bool) -> Result<Started> {
        let t = self.env.task(call, id).await?;
        let setting = self.env.setting(call).await;
        let setting = {
            let mut running = self.lock();
            let d = Due { has_worktree: !t.dir.is_empty(), is_child: t.is_child, pr_open: t.pr_open, pr_head: &t.pr_head, setting: &setting, force, running: running.get(id).map(String::as_str), busy: t.live || t.shipping, last: t.review.as_ref() };
            match core::gate(&d) {
                Gate::Refuse(why) => return Ok(Started { why, job: None }),
                Gate::Quiet => return Ok(Started { why: String::new(), job: None }),
                // claimed before any await, so two callers never start two runs of one head
                Gate::Pick { setting } => {
                    running.insert(id.to_owned(), t.pr_head.clone());
                    setting
                }
            }
        };
        let (agents_of_turns, _) = self.env.turns(call, id).await;
        let authors = core::authors_of(&t.agent, agents_of_turns.iter().map(String::as_str));
        let agents = self.env.agents(call).await;
        let pick = core::pick_reviewer(&setting, &authors, &agents);
        // the reviewer's own account, at Automations' stop at: it waits, it never moves to another
        let hold = match (&pick, force) {
            (Ok(p), false) => self.env.hold(call, &p.agent).await,
            _ => None,
        };
        match core::after_pick(&t.pr_head, pick, hold, self.env.now()) {
            Decision::Stop { review, why } => {
                self.release(id, &t.pr_head);
                self.env.save(call, id, Some(&review), false).await?;
                Ok(Started { why, job: None })
            }
            Decision::Start { review, pick } => {
                if let Err(e) = self.env.save(call, id, Some(&review), false).await {
                    self.release(id, &t.pr_head);
                    return Err(e);
                }
                let me = self.clone();
                let call = call.clone();
                let name = agents.iter().find(|a| a.id == pick.agent).map_or_else(|| pick.agent.clone(), |a| a.name.clone());
                Ok(Started { why: String::new(), job: Some(Box::pin(async move { me.run(&call, t, pick, name).await })) })
            }
        }
    }

    fn release(&self, id: &str, head: &str) {
        let mut running = self.lock();
        if running.get(id).is_some_and(|h| h == head) {
            running.remove(id);
        }
    }

    /// Still worth finishing: this head is still the one running, and still the PR's.
    async fn live(&self, call: &Call, id: &str, head: &str) -> bool {
        self.lock().get(id).is_some_and(|h| h == head) && self.env.task(call, id).await.is_ok_and(|t| t.pr_head == head)
    }

    async fn run(&self, call: &Call, t: Task, pick: Pick, reviewer: String) {
        let head = t.pr_head.clone();
        let _span = tracing::info_span!("review.run", session = %t.id, head = %head, reviewer = %pick.agent);
        let mut got = Gathered::default();
        let outcome = self.attempt(call, &t, &pick, &reviewer, &mut got).await;
        let review = match outcome {
            // overtaken (a new head, a newer review): nothing of this one is kept
            None => None,
            Some(Err(why)) => Some(core::finish(Finish { head: &head, pick: &pick, tests: None, constraints: Vec::new(), coverage: got.coverage, now: self.env.now() }, Outcome::Error { why })),
            Some(Ok(o)) => Some(core::finish(Finish { head: &head, pick: &pick, tests: got.tests.as_ref(), constraints: got.rules, coverage: got.coverage, now: self.env.now() }, o)),
        };
        let keep = match &review {
            Some(_) => self.live(call, &t.id, &head).await,
            None => false,
        };
        self.release(&t.id, &head);
        if let (Some(r), true) = (review, keep) {
            if let Err(e) = self.env.save(call, &t.id, Some(&r), true).await {
                tracing::warn!(error = %e, "review: couldn't keep the result");
            }
            self.env.finished(call, &finished_of(&t, &r));
        }
    }

    async fn attempt(&self, call: &Call, t: &Task, pick: &Pick, reviewer: &str, got: &mut Gathered) -> Option<std::result::Result<Outcome, String>> {
        let env = &self.env;
        // the PR's head, as pushed: a tree that moved on is reviewed once that's pushed
        if env.head(call, &t.dir).await.as_deref() != Some(t.pr_head.as_str()) {
            return Some(Err(core::machine::UNPUSHED.into()));
        }
        got.tests = env.tests(call, &t.dir, &t.cwd).await;
        if !self.live(call, &t.id, &t.pr_head).await {
            return None;
        }
        let base = if t.base_ref.is_empty() { "HEAD" } else { t.base_ref.as_str() };
        got.rules = core::constraints_for(env.constraints(call, &t.id).await, &t.goal);
        // nothing to go on is a failed review, not a review of nothing
        let Some((files, listed)) = env.changes(call, &t.dir, base).await else { return Some(Err(core::machine::NO_DIFF.into())) };
        let (sections, mut paths) = core::sections_of(&files);
        paths.extend(listed.into_iter().filter(|p| !paths_has(&files, p)));
        let (diff, cov) = core::fit_diff(&sections, &paths, core::MAX_DIFF);
        let (_, task) = env.turns(call, &t.id).await;
        let prompt = core::review_prompt(&PromptInput { title: &t.title, task: &task, diff: &diff, tests: got.tests.as_ref(), constraints: &got.rules, coverage: Some(&cov) });
        got.coverage = Some(cov);
        let answer = env.ask(call, prompt, &t.dir, pick, REVIEW_MS).await;
        if !self.live(call, &t.id, &t.pr_head).await {
            return None;
        }
        Some(Ok(match answer.as_ref().and_then(|j| core::read_review(j, &got.rules)) {
            Some((summary, findings)) => Outcome::Answered { summary, findings },
            None => Outcome::Silent { reviewer: reviewer.to_owned() },
        }))
    }
}

/// What a run gathered on its way, kept on the review whatever the outcome.
#[derive(Debug, Default)]
struct Gathered {
    coverage: Option<wisp_review_api::Coverage>,
    tests: Option<TestsRun>,
    rules: Vec<String>,
}

fn paths_has(files: &[wisp_git_api::FileDiff], p: &str) -> bool {
    files.iter().any(|f| f.path == p)
}

fn finished_of(t: &Task, r: &Review) -> ReviewFinished {
    let n = |x: usize| u32::try_from(x).unwrap_or(u32::MAX);
    ReviewFinished {
        session_id: t.id.clone(),
        head: r.head.clone(),
        status: r.status,
        reviewer: r.by.as_ref().map(|p| p.agent.clone()).unwrap_or_default(),
        author: t.agent.clone(),
        findings: n(r.findings.len()),
        constraints: n(r.constraints.len()),
        broken: n(r.findings.iter().filter(|f| f.constraint.is_some() && f.severity == Severity::High).count()),
        tests: r.tests.as_ref().map_or_else(|| "skip".into(), |t| t.verdict.clone()),
        partial: r.coverage.as_ref().is_some_and(wisp_review_api::Coverage::partial),
    }
}

/// A review cut short by a restart starts over: the running ones are cleared at boot.
pub async fn boot(env: &dyn Env, call: &Call, tasks: Vec<Task>) {
    for t in tasks.into_iter().filter(|t| t.review.as_ref().is_some_and(|r| r.status == Status::Running)) {
        let _ = env.save(call, &t.id, core::on_boot(t.review.clone()).as_ref(), false).await;
    }
}
