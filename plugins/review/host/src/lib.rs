//! wisp.review: review by another harness. `review.maybe` (ship calls it when a PR's head changes; a
//! turn's end calls it; `force` is Review again) and `review.view`.

pub mod flow;
pub mod ports;

use std::sync::Arc;

use serde_json::Value;
use wisp_git_api::{Body, FileDiff, GitServiceV1};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_review_api::{CONSTRAINTS, EXT, HOLD, Maybe, MaybeReview, Pick, Review, ReviewFinished, TESTS, TestsRun, View};
use wisp_review_core::Agent;
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::events::TurnEnded;

pub use flow::{Reviewer, Started, boot};
pub use ports::{Env, Fut, Task, task_of};

/// The setting that says who reviews (v1 `defaults.review`).
pub const SETTING: &str = "review.harness";

#[derive(Debug, Default)]
pub struct ReviewPlugin;

impl Plugin for ReviewPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let ctx = s.ctx();
        s.contribute(&wisp_runtime_api::points::SUMMARY, Arc::new(Row(ctx.clone())) as Arc<dyn wisp_runtime_api::points::SummaryField>);
        let env: Arc<dyn Env> = Arc::new(KernelEnv(ctx.clone()));
        let reviewer = Reviewer::new(env.clone());
        let r = reviewer.clone();
        s.command::<MaybeReview, _, _>(move |ctx, call, args| {
            let r = r.clone();
            async move { start(&ctx, &r, &call, &args.id, args.force).await }
        });
        let e = env.clone();
        s.command::<View, _, _>(move |_ctx, call, args| {
            let e = e.clone();
            async move {
                let t = e.task(&call, &args.id).await?;
                Ok(wisp_review_core::review_view(t.review.as_ref(), t.pr_open.then_some(t.pr_head.as_str())))
            }
        });
        // a run that ends on a task with an open PR: its head may be new (the agent pushed)
        let r = reviewer.clone();
        s.on::<TurnEnded, _, _>(move |ctx, e| {
            let r = r.clone();
            async move {
                let _ = start(&ctx, &r, &ctx.root_call(), e.session_id.as_str(), false).await;
            }
        });
        s.on_start(move |ctx| async move {
            let call = ctx.root_call();
            let all = ctx.run::<rt::List>(&call, rt::ListArgs { archived: None, limit: None }).await.unwrap_or_default();
            let mut tasks = Vec::new();
            for s in all {
                if let Ok(t) = env.task(&call, s.id.as_str()).await {
                    tasks.push(t);
                }
            }
            boot(env.as_ref(), &call, tasks).await;
            Ok(())
        });
        Ok(())
    }
}

/// `runtime.summary@1`: the review on the task's row (`review`, as `review.view` says it, current when
/// it's of the PR's head) and whether Settings → Review by another harness is on (`reviewOn`).
struct Row(Ctx);

/// The setting is on: anything but unset or `off`.
pub fn review_on(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|h| !h.is_empty() && h != "off")
}

/// The row's review fields from the session's slots.
pub fn row_fields(session: &wisp_runtime_api::model::Session, on: bool, out: &mut std::collections::BTreeMap<String, Value>) {
    if on {
        out.insert("reviewOn".into(), Value::Bool(true));
    }
    let r: Option<Review> = serde_json::from_value(session.ext_of(EXT).clone()).ok();
    let pr = &session.ext_of(wisp_review_api::SHIP_EXT)["pr"];
    let head = (pr["state"] == "OPEN").then(|| pr["head"].as_str().unwrap_or_default());
    if let Some(v) = wisp_review_core::review_view(r.as_ref(), head).and_then(|v| serde_json::to_value(v).ok()) {
        out.insert("review".into(), v);
    }
}

impl wisp_runtime_api::points::SummaryField for Row {
    fn plugin(&self) -> &str {
        EXT
    }
    fn fields(
        &self,
        session: &wisp_runtime_api::model::Session,
        _last: Option<&wisp_runtime_api::model::Turn>,
        out: &mut std::collections::BTreeMap<String, Value>,
    ) {
        row_fields(session, review_on(self.0.setting(SETTING).as_ref()), out);
    }
}

/// `maybe`, with its run spawned on the plugin's scope (freed when review is switched off).
async fn start(ctx: &Ctx, r: &Arc<Reviewer>, call: &Call, id: &str, force: bool) -> Result<Maybe> {
    let started = r.maybe(call, id, force).await?;
    if let Some(job) = started.job {
        ctx.spawn(job);
    }
    Ok(Maybe { why: started.why })
}

/// The port over the kernel: runtime's commands, git.service, review's points and settings.
struct KernelEnv(Ctx);

impl KernelEnv {
    async fn repo(ctx: &Ctx, call: &Call, dir: &str) -> Option<Arc<dyn wisp_git_api::Repo>> {
        let git = ctx.use_service::<GitServiceV1>().ok()?;
        git.repo(call, ctx.scope(), dir).await.ok()
    }
}

impl Env for KernelEnv {
    fn task(&self, call: &Call, id: &str) -> Fut<Result<Task>> {
        let f = self.0.run::<rt::Get>(call, rt::IdArgs { id: id.into() });
        Box::pin(async move { f.await.map(|s| task_of(&s)) })
    }
    fn turns(&self, call: &Call, id: &str) -> Fut<(Vec<String>, String)> {
        let f = self.0.run::<rt::Turns>(call, rt::TurnsArgs { id: id.into(), before: None, limit: None, masked: None });
        Box::pin(async move {
            let turns = f.await.unwrap_or_default();
            let first = turns.iter().min_by_key(|t| t.idx).map(|t| t.prompt.clone()).unwrap_or_default();
            (turns.into_iter().map(|t| t.agent).collect(), first)
        })
    }
    fn setting(&self, _call: &Call) -> Fut<String> {
        let v = self.0.setting(SETTING).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "off".into());
        Box::pin(async move { v })
    }
    fn agents(&self, call: &Call) -> Fut<Vec<Agent>> {
        let f = self.0.run::<rt::Agents>(call, rt::AgentsArgs { fresh: None });
        Box::pin(async move {
            f.await.unwrap_or_default().into_iter().map(|a| Agent { id: a.id, name: a.name, available: a.available }).collect()
        })
    }
    fn hold(&self, call: &Call, agent: &str) -> Fut<Option<String>> {
        let all: Vec<_> = self.0.contributions(&HOLD).iter().map(|h| h.check(call, agent)).collect();
        Box::pin(async move {
            for f in all {
                if let Some(why) = f.await {
                    return Some(why);
                }
            }
            None
        })
    }
    fn constraints(&self, call: &Call, id: &str) -> Fut<Vec<String>> {
        let f = self.0.contributions(&CONSTRAINTS).first().map(|c| c.of(call, id));
        Box::pin(async move { if let Some(f) = f { f.await.unwrap_or_default() } else { Vec::new() } })
    }
    fn head(&self, call: &Call, dir: &str) -> Fut<Option<String>> {
        let (ctx, call, dir) = (self.0.clone(), call.clone(), dir.to_owned());
        Box::pin(async move { Self::repo(&ctx, &call, &dir).await?.rev_parse(&call, "HEAD").await.ok().flatten() })
    }
    fn changes(&self, call: &Call, dir: &str, base: &str) -> Fut<Option<(Vec<FileDiff>, Vec<String>)>> {
        let (ctx, call, dir, base) = (self.0.clone(), call.clone(), dir.to_owned(), base.to_owned());
        Box::pin(async move {
            let c = Self::repo(&ctx, &call, &dir).await?.changes(&call, &base).await.ok().flatten()?;
            let listed = c.stats.iter().map(|s| s.path.clone()).collect();
            // a diff too big to go inline (a blob ref) is listed, not read: every file shows as missing
            let files = match c.body {
                Body::Inline { files } => files,
                Body::Blob { .. } => Vec::new(),
            };
            Some((files, listed))
        })
    }
    fn tests(&self, call: &Call, dir: &str, cwd: &str) -> Fut<Option<TestsRun>> {
        let f = self.0.contributions(&TESTS).first().map(|t| t.run(call, dir, cwd));
        Box::pin(async move { if let Some(f) = f { f.await.ok().flatten() } else { None } })
    }
    fn ask(&self, call: &Call, prompt: String, cwd: &str, pick: &Pick, timeout_ms: u64) -> Fut<Option<Value>> {
        let model = (!pick.model.is_empty()).then(|| pick.model.clone());
        let args = rt::QuickArgs {
            prompt,
            cwd: cwd.to_owned(),
            pick: Some(rt::RunPick { agent: Some(pick.agent.clone()), model, effort: None }),
            timeout_ms: Some(timeout_ms),
            json: true,
            run_id: None,
        };
        let f = self.0.run::<rt::Quick>(call, args);
        Box::pin(async move { f.await.ok().and_then(|r| r.json) })
    }
    fn save(&self, call: &Call, id: &str, review: Option<&Review>, unread: bool) -> Fut<Result<()>> {
        let value = match review.map(serde_json::to_value).transpose() {
            Ok(v) => v.unwrap_or(Value::Null),
            Err(e) => return Box::pin(async move { Err(WireError::internal(e.to_string())) }),
        };
        let set = self.0.run::<rt::SetExt>(call, rt::SetExtArgs { id: id.into(), plugin: EXT.into(), value, expect: None });
        let read = unread.then(|| self.0.run::<rt::MarkRead>(call, rt::MarkReadArgs { id: id.into(), unread: true }));
        Box::pin(async move {
            set.await?;
            if let Some(r) = read {
                r.await?;
            }
            Ok(())
        })
    }
    fn finished(&self, call: &Call, e: &ReviewFinished) {
        self.0.emit(call, e);
    }
    fn now(&self) -> i64 {
        self.0.clock().map_or(0, |c| c.now_ms())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod row_tests {
    use std::collections::BTreeMap;

    use serde_json::json;
    use wisp_runtime_api::model::Session;

    use super::{review_on, row_fields};

    fn task(pr_head: &str, review_head: &str) -> Session {
        let mut s = Session { id: "t1".into(), ..Session::default() };
        s.ext.insert("wisp.ship".into(), json!({ "pr": { "state": "OPEN", "head": pr_head } }));
        s.ext.insert("wisp.review".into(), json!({ "status": "done", "head": review_head, "findings": [], "at": 3, "coverage": { "files": 4, "seen": 2, "chars": 10, "seenChars": 5, "cut": [], "missing": [] } }));
        s
    }

    #[test]
    fn the_row_says_the_review_and_whether_it_is_of_the_prs_head() {
        let mut out = BTreeMap::new();
        row_fields(&task("abc", "abc"), true, &mut out);
        assert_eq!(out["reviewOn"], true);
        assert_eq!(out["review"]["current"], true);
        assert_eq!(out["review"]["coverage"]["seen"], 2, "a partial read reaches the chip (says Partial, never a pass)");
        let mut out = BTreeMap::new();
        row_fields(&task("def", "abc"), false, &mut out);
        assert_eq!(out["review"]["current"], false, "a push after it: not current");
        assert!(!out.contains_key("reviewOn"));
        let mut out = BTreeMap::new();
        row_fields(&Session::default(), true, &mut out);
        assert!(!out.contains_key("review"));
    }

    #[test]
    fn review_is_on_for_any_harness_but_off() {
        assert!(!review_on(None));
        assert!(!review_on(Some(&json!("off"))));
        assert!(review_on(Some(&json!("other"))));
        assert!(review_on(Some(&json!("codex"))));
    }
}
