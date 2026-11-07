//! A stand-in for the GitHub CLI behind the proc service, as v1's test/fixtures/fake-gh.mjs: pull
//! requests live in memory; `pr merge` refuses a head that moved or a draft.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use wisp_kernel::BoxFuture;
use wisp_proc::{Child, ExecOpts, ExecResult, Exit, ProcError, ProcService, SpawnOpts};

#[derive(Debug, Default)]
pub struct GhState {
    pub prs: BTreeMap<u64, Value>,
    pub checks: Option<Value>,
    pub review: Option<String>,
    pub mergeable: Option<String>,
    pub review_comments: Value,
    pub run_log: Option<String>,
    /// every call's argv and cwd
    pub calls: Vec<(Vec<String>, String)>,
    /// the head each branch has on the remote (pushes move it)
    pub heads: BTreeMap<String, String>,
    pub env_seen: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct FakeGh {
    pub st: Arc<Mutex<GhState>>,
}

fn ok(out: &str) -> ExecResult {
    ExecResult { exit: Exit { code: Some(0), signal: None }, stdout: out.as_bytes().to_vec(), stderr: Vec::new(), timed_out: false, truncated: false }
}

fn fail(why: &str) -> ExecResult {
    ExecResult { exit: Exit { code: Some(1), signal: None }, stdout: Vec::new(), stderr: why.as_bytes().to_vec(), timed_out: false, truncated: false }
}

fn flag<'a>(args: &'a [String], f: &str) -> Option<&'a str> {
    args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).map(String::as_str)
}

impl FakeGh {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, GhState> {
        self.st.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn calls(&self, sub: &str) -> Vec<Vec<String>> {
        self.lock().calls.iter().filter(|(a, _)| a.get(1).is_some_and(|s| s == sub)).map(|(a, _)| a.clone()).collect()
    }

    pub fn add_pr(&self, pr: Value) {
        let n = pr["number"].as_u64().unwrap_or(0);
        self.lock().prs.insert(n, pr);
    }

    fn find(st: &GhState, r: &str) -> Option<u64> {
        st.prs.values().find(|p| p["number"].as_u64().is_some_and(|n| n.to_string() == r) || p["url"] == r || p["headRefName"] == r).and_then(|p| p["number"].as_u64())
    }

    fn handle(&self, args: &[String]) -> ExecResult {
        let mut st = self.lock();
        let a = |i: usize| args.get(i).map_or("", String::as_str);
        match (a(0), a(1)) {
            ("pr", "create") => {
                let n = st.prs.len() as u64 + 1;
                let head = flag(args, "--head").unwrap_or_default().to_owned();
                let url = format!("https://github.com/acme/repo/pull/{n}");
                let oid = st.heads.get(&head).cloned().unwrap_or_default();
                let checks = st.checks.clone().unwrap_or(json!([]));
                st.prs.insert(n, json!({"number": n, "url": url, "title": flag(args, "--title"), "body": flag(args, "--body"), "state": "OPEN", "isDraft": args.iter().any(|x| x == "--draft"),
                    "reviewDecision": "", "mergeStateStatus": "CLEAN", "headRefName": head, "baseRefName": flag(args, "--base"), "headRefOid": oid, "statusCheckRollup": checks, "mergedAt": null}));
                ok(&format!("Creating pull request for {head} into main\n\n{url}\n"))
            }
            ("pr", "view") => {
                let Some(n) = Self::find(&st, a(2)) else { return fail("no pull requests found") };
                let (checks, review, mergeable) = (st.checks.clone(), st.review.clone(), st.mergeable.clone());
                let head = st.prs[&n]["headRefName"].as_str().and_then(|b| st.heads.get(b)).cloned();
                let pr = st.prs.get_mut(&n).map(|p| {
                    if let Some(c) = checks { p["statusCheckRollup"] = c; }
                    if let Some(r) = review { p["reviewDecision"] = json!(r); }
                    if let Some(m) = mergeable { p["mergeable"] = json!(m); }
                    if let Some(h) = head { p["headRefOid"] = json!(h); }
                    p.clone()
                });
                ok(&pr.unwrap_or(Value::Null).to_string())
            }
            ("pr", "ready") => match Self::find(&st, a(2)) {
                Some(n) => {
                    if let Some(p) = st.prs.get_mut(&n) { p["isDraft"] = json!(false); }
                    ok("")
                }
                None => fail("not found"),
            },
            ("pr", "merge") => {
                let Some(n) = Self::find(&st, a(2)) else { return fail("not found") };
                let p = &st.prs[&n];
                let head = p["headRefName"].as_str().and_then(|b| st.heads.get(b)).cloned().unwrap_or_else(|| p["headRefOid"].as_str().unwrap_or_default().to_owned());
                if flag(args, "--match-head-commit") != Some(head.as_str()) {
                    return fail("GraphQL: Head branch was modified. Review and try the merge again.");
                }
                if p["isDraft"] == json!(true) {
                    return fail("error: Pull request is still a draft");
                }
                if let Some(p) = st.prs.get_mut(&n) {
                    p["state"] = json!("MERGED");
                    p["mergedAt"] = json!("2026-10-28T12:00:00Z");
                }
                ok("")
            }
            ("api", route) if route.contains("/pulls/") => ok(&st.review_comments.to_string()),
            ("run", "view") => st.run_log.clone().map_or_else(|| fail("no log"), |l| ok(&l)),
            _ => fail(&format!("fake gh: unsupported: {}", args.join(" "))),
        }
    }
}

impl ProcService for FakeGh {
    fn which(&self, _bin: &str, _env: Option<Vec<(String, String)>>) -> BoxFuture<'static, Option<PathBuf>> {
        Box::pin(async { Some(PathBuf::from("/sim/gh")) })
    }
    fn spawn(&self, _bin: &str, _args: &[String], _opts: SpawnOpts) -> wisp_proc::Result<Child> {
        Err(ProcError::Unsupported("spawn"))
    }
    fn exec(&self, _bin: &str, args: &[String], opts: ExecOpts) -> BoxFuture<'static, wisp_proc::Result<ExecResult>> {
        {
            let mut st = self.lock();
            st.calls.push((args.to_vec(), opts.cwd.map(|c| c.display().to_string()).unwrap_or_default()));
            st.env_seen.clone_from(&opts.env.set);
        }
        let out = self.handle(args);
        Box::pin(async move { Ok(out) })
    }
    fn spawn_detached(&self, _bin: &str, _args: &[String], _opts: SpawnOpts) -> wisp_proc::Result<u32> {
        Err(ProcError::Unsupported("spawn_detached"))
    }
    fn live(&self) -> usize {
        0
    }
    fn kill_all(&self, _grace: Duration) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}
