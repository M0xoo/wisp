//! wisp.github: CI as a trigger source (ADR-0043, `trigger.source@1`): `ci.failed` and `ci.passed`, polled with
//! `gh run list` in the trigger's project, through the proc service. A 403 rate limit answers `retry_at` (from
//! `gh api rate_limit`), which the engine waits for without counting a failure.
//!
//! The channels transport (mentions, issue replies) is ported later.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_automations_api::{Polled, SOURCE, SourceOn, TriggerSource};
use wisp_github_core::ci;
use wisp_kernel::{BoxFuture, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::{Env, ExecOpts, Proc};

#[derive(Debug, Default)]
pub struct GithubPlugin;

struct Ci(Ctx);

fn gh_bin() -> String {
    std::env::var("WISP_GH_BIN").unwrap_or_else(|_| "gh".into())
}

fn opts(cwd: &str) -> ExecOpts {
    ExecOpts {
        cwd: (!cwd.is_empty()).then(|| cwd.into()),
        env: Env::default().with("GH_PROMPT_DISABLED", "1").with("GH_NO_UPDATE_NOTIFIER", "1").with("GIT_TERMINAL_PROMPT", "0"),
        timeout: Some(Duration::from_secs(30)),
        ..ExecOpts::default()
    }
}

async fn poll(proc: Arc<Proc>, on: String, spec: Value, cursor: Value) -> Result<Polled> {
    let s = |k: &str| spec.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let cwd = s("project");
    let r = proc.exec(&gh_bin(), &ci::run_list_args(&s("branch")), opts(&cwd)).await.map_err(|e| WireError::unavailable(format!("gh: {e}")))?;
    if r.timed_out {
        return Err(WireError::unavailable("gh run list timed out after 30 s"));
    }
    if !r.exit.success() {
        let err = r.stderr_text();
        if ci::rate_limited(&err) {
            let reset = proc.exec(&gh_bin(), &["api".into(), "rate_limit".into()], opts(&cwd)).await.ok().and_then(|o| ci::reset_at(&o.stdout_text()));
            // no reset said (0): the engine waits an hour
            return Ok(Polled { events: Vec::new(), cursor, retry_at: Some(reset.unwrap_or(0)) });
        }
        return Err(WireError::unavailable(format!("gh run list: {}", err.trim())));
    }
    let (events, cursor) = ci::ci_events(&on, &r.stdout_text(), &cursor).map_err(WireError::internal)?;
    Ok(Polled { events, cursor, retry_at: None })
}

impl TriggerSource for Ci {
    fn plugin(&self) -> &'static str {
        "wisp.github"
    }
    fn ons(&self) -> Vec<SourceOn> {
        let fields = json!({ "type": "object", "properties": { "branch": { "type": "string" }, "workflow": { "type": "string" }, "project": { "type": "string" } } });
        vec![
            SourceOn { on: "ci.failed".into(), title: "CI failed".into(), fields: fields.clone(), mode: "poll".into(), every: Some(5) },
            SourceOn { on: "ci.passed".into(), title: "CI passed".into(), fields, mode: "poll".into(), every: Some(5) },
        ]
    }
    fn poll(&self, on: &str, spec: &Value, cursor: Value) -> BoxFuture<'static, Result<Polled>> {
        let proc = self.0.service::<Proc>();
        let (on, spec) = (on.to_owned(), spec.clone());
        Box::pin(async move { poll(proc?, on, spec, cursor).await })
    }
}

impl Plugin for GithubPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let src: Arc<dyn TriggerSource> = Arc::new(Ci(s.ctx()));
        s.contribute(&SOURCE, src);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(GithubPlugin.manifest().id, "wisp.github");
    }
}
