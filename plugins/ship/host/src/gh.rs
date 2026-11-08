//! The GitHub CLI, through the kernel's proc service (async, never blocking): PR view, create, ready,
//! merge, a PR's inline comments, a failing job's log. Never waits on a prompt nobody can see.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_ship_api::{PrDetail, PrSummary};
use wisp_ship_core::{DETAIL_FIELDS, PR_FIELDS, pr_detail_of, pr_summary, pull_coords, threads_of};

use crate::error::{Result, ShipError};

/// gh's default; git pushes inside it take longer than a view.
const GH_TIMEOUT: Duration = Duration::from_secs(120);

/// Never wait on a credential or confirmation prompt nobody can see (edge case Git 1).
pub const QUIET_ENV: [(&str, &str); 5] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GIT_EDITOR", "true"),
    ("GIT_OPTIONAL_LOCKS", "0"),
];

#[derive(Clone)]
pub struct Gh {
    proc: Proc,
    bin: String,
}

impl std::fmt::Debug for Gh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gh")
            .field("bin", &self.bin)
            .finish_non_exhaustive()
    }
}

/// What a failed gh said: its `error:`/`fatal:` line, else its last three lines, else how it ended.
pub fn why(stderr: &str, fallback: &str) -> String {
    let lines: Vec<&str> = stderr
        .trim()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if let Some(l) = lines.iter().find(|l| {
        let low = l.to_ascii_lowercase();
        low.starts_with("fatal") || low.starts_with("error")
    }) {
        return (*l).to_owned();
    }
    if lines.is_empty() {
        fallback.to_owned()
    } else {
        lines[lines.len().saturating_sub(3)..].join(" ")
    }
}

impl Gh {
    pub fn new(proc: Proc, bin: impl Into<String>) -> Self {
        Self {
            proc,
            bin: bin.into(),
        }
    }

    /// Runs gh in `cwd`; its stdout, trimmed.
    pub async fn run(
        &self,
        cwd: &str,
        args: &[String],
        timeout: Option<Duration>,
    ) -> Result<String> {
        let env = QUIET_ENV
            .iter()
            .fold(Env::default(), |e, (k, v)| e.with(*k, *v));
        let opts = ExecOpts {
            cwd: Some(PathBuf::from(cwd)),
            env,
            timeout: Some(timeout.unwrap_or(GH_TIMEOUT)),
            ..ExecOpts::default()
        };
        let out = self
            .proc
            .exec(&self.bin, args, opts)
            .await
            .map_err(|e| ShipError::Gh(e.to_string()))?;
        if out.exit.success() {
            return Ok(out.stdout_text().trim().to_owned());
        }
        let ended = if out.timed_out {
            format!("gh {} timed out", args.first().map_or("", String::as_str))
        } else {
            format!("gh exited with {}", out.exit.shell_code())
        };
        Err(ShipError::Gh(why(&out.stderr_text(), &ended)))
    }

    async fn json(&self, cwd: &str, args: &[String]) -> Result<Value> {
        let out = self.run(cwd, args, None).await?;
        serde_json::from_str(&out)
            .map_err(|e| ShipError::Gh(format!("gh said something that isn't JSON: {e}")))
    }

    /// `gh pr view <ref>` (a number in `cwd`'s repo, a URL, or a branch).
    pub async fn pr_view(&self, cwd: &str, pr_ref: &str, now: i64) -> Result<PrSummary> {
        let args = strings(&["pr", "view", pr_ref, "--json", PR_FIELDS]);
        Ok(pr_summary(&self.json(cwd, &args).await?, now))
    }

    /// The PR in full for the panel. Its inline threads are a second call that may fail (an old gh, no
    /// access): the rest still shows.
    pub async fn pr_detail(&self, cwd: &str, pr_ref: &str, now: i64) -> Result<PrDetail> {
        let j = self
            .json(
                cwd,
                &strings(&["pr", "view", pr_ref, "--json", DETAIL_FIELDS]),
            )
            .await?;
        let url = j.get("url").and_then(Value::as_str).unwrap_or_default();
        let raw = match pull_coords(url) {
            Some((o, r, n)) => self
                .json(
                    cwd,
                    &[
                        String::from("api"),
                        format!("repos/{o}/{r}/pulls/{n}/comments?per_page=100"),
                    ],
                )
                .await
                .unwrap_or(Value::Null),
            None => Value::Null,
        };
        let threads = threads_of(raw.as_array().map_or(&[][..], Vec::as_slice));
        Ok(pr_detail_of(&j, threads, now))
    }

    /// A failing Actions job's log (`--log-failed`), "" when gh can't read it.
    pub async fn job_log(&self, cwd: &str, owner: &str, repo: &str, job: &str) -> String {
        let args = [
            String::from("run"),
            "view".into(),
            "--job".into(),
            job.into(),
            "--log-failed".into(),
            "-R".into(),
            format!("{owner}/{repo}"),
        ];
        self.run(cwd, &args, Some(Duration::from_secs(60)))
            .await
            .unwrap_or_default()
    }
}

pub fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}
