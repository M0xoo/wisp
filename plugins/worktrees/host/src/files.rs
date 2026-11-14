//! `files.changed` (ADR-0043): a polled trigger source. Each poll runs `git status` in the trigger's project
//! through the proc service; `wisp_worktrees_core::changes` decides whether that's new.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_automations_api::{Polled, SOURCE, SourceOn, TriggerSource};
use wisp_kernel::services::Paths;
use wisp_kernel::{BoxFuture, Ctx, Result, Setup, WireError};
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_worktrees_core::changes;

struct Files(Ctx);

async fn poll(ctx: Ctx, spec: Value, cursor: Value) -> Result<Polled> {
    let project = spec.get("project").and_then(Value::as_str).unwrap_or_default().to_owned();
    if project.is_empty() {
        return Err(WireError::invalid("files.changed needs a project (the folder it watches)"));
    }
    let proc = ctx.service::<Proc>()?;
    let home = ctx.service::<Paths>().map(|p| p.home().to_string_lossy().into_owned()).unwrap_or_default();
    let now = ctx.clock()?.now_ms();
    let args: Vec<String> = changes::STATUS_ARGS.iter().map(|s| (*s).to_owned()).collect();
    let opts = ExecOpts {
        cwd: Some(project.clone().into()),
        env: Env::default().with("GIT_TERMINAL_PROMPT", "0").with("GIT_OPTIONAL_LOCKS", "0"),
        timeout: Some(Duration::from_secs(20)),
        ..ExecOpts::default()
    };
    let r = proc.exec("git", &args, opts).await.map_err(|e| WireError::unavailable(format!("git: {e}")))?;
    if r.timed_out || !r.exit.success() {
        return Err(WireError::unavailable(format!(
            "git status in {project}: {}",
            if r.timed_out { "timed out after 20 s".to_owned() } else { r.stderr_text().trim().to_owned() }
        )));
    }
    let (ev, cursor) = changes::files_changed(&project, &r.stdout_text(), &cursor, &home, now);
    Ok(Polled { events: ev.into_iter().collect(), cursor, retry_at: None })
}

impl TriggerSource for Files {
    fn plugin(&self) -> &'static str {
        "wisp.worktrees"
    }
    fn ons(&self) -> Vec<SourceOn> {
        vec![SourceOn {
            on: "files.changed".into(),
            title: "Files changed".into(),
            fields: json!({ "type": "object", "properties": { "project": { "type": "string" }, "paths": { "type": "array", "items": { "type": "string" } } }, "required": ["project"] }),
            mode: "poll".into(),
            every: Some(1),
        }]
    }
    fn poll(&self, _on: &str, spec: &Value, cursor: Value) -> BoxFuture<'static, Result<Polled>> {
        Box::pin(poll(self.0.clone(), spec.clone(), cursor))
    }
}

pub fn register(s: &mut Setup) {
    let src: Arc<dyn TriggerSource> = Arc::new(Files(s.ctx()));
    s.contribute(&SOURCE, src);
}
