//! `sandbox.seed`, inside a sandbox only (`WISP_SANDBOX=1`, ADR-0047): the project comes in as a bundle and its
//! uncommitted changes, lands in `~/code/<name>` with its origin and author, and its `.wisp/sandbox.sh` runs once.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use wisp_kernel::{Ctx, Result, WireError};
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_sandbox_api as api;
use wisp_sandbox_core as core;

/// Whether this wisp is a sandbox's (the grid starts a sandbox's box with `WISP_SANDBOX=1`).
pub fn in_sandbox(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env("WISP_SANDBOX").is_some_and(|v| v == "1")
}

async fn run(proc: &Proc, cwd: &Path, bin: &str, args: &[String], input: Option<Vec<u8>>, secs: u64) -> std::result::Result<String, String> {
    let opts = ExecOpts { cwd: Some(cwd.to_owned()), env: Env::default().with("GIT_TERMINAL_PROMPT", "0"), input, timeout: Some(Duration::from_secs(secs)), max_output: 1 << 20, ..ExecOpts::default() };
    let r = proc.exec(bin, args, opts).await.map_err(|e| e.to_string())?;
    if r.exit.success() { Ok(r.stdout_text()) } else { Err(format!("{}{}", r.stdout_text(), r.stderr_text()).trim().to_owned()) }
}

/// Takes the project into `home/code/<name>`; its folder, and what its setup said when it ran.
pub async fn seed(ctx: &Ctx, home: &Path, a: &api::SeedArgs) -> Result<api::Seeded> {
    let proc = ctx.service::<Proc>()?;
    let name = core::name_of(&a.name);
    let code = home.join("code");
    let dir = code.join(&name);
    tokio::fs::create_dir_all(&code).await.map_err(|e| WireError::internal(format!("~/code: {e}")))?;
    if a.bundle.is_empty() {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| WireError::internal(format!("{name}: {e}")))?;
        return Ok(api::Seeded { cwd: dir.display().to_string(), setup: None });
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(a.bundle.as_bytes()).map_err(|_| WireError::invalid("the bundle isn't base64"))?;
    let bundle = home.join(format!(".sandbox/{name}.bundle"));
    if let Some(p) = bundle.parent() {
        let _ = tokio::fs::create_dir_all(p).await;
    }
    tokio::fs::write(&bundle, bytes).await.map_err(|e| WireError::internal(format!("the bundle: {e}")))?;
    // the same project again (a member's own sandbox, the next job): a fresh copy of what came now
    let _ = tokio::fs::remove_dir_all(&dir).await;
    for args in core::seed_commands(&bundle.display().to_string(), &dir.display().to_string(), &a.branch, &a.origin) {
        run(&proc, &code, "git", &args, None, 300).await.map_err(|e| WireError::internal(format!("git {}: {e}", args.first().map_or("", String::as_str))))?;
    }
    let _ = tokio::fs::remove_file(&bundle).await;
    let set = |k: &str, v: &str| ["config", k, v].map(str::to_owned).to_vec();
    if !a.author_name.is_empty() {
        let _ = run(&proc, &dir, "git", &set("user.name", &a.author_name), None, 10).await;
    }
    if !a.author_email.is_empty() {
        let _ = run(&proc, &dir, "git", &set("user.email", &a.author_email), None, 10).await;
    }
    if !a.patch.trim().is_empty() {
        let apply = ["apply", "--whitespace=nowarn", "-"].map(str::to_owned).to_vec();
        run(&proc, &dir, "git", &apply, Some(a.patch.clone().into_bytes()), 60).await.map_err(|e| WireError::internal(format!("the uncommitted changes didn't apply: {e}")))?;
    }
    // what it was when it came: a delegate's changes go back as the difference from this (no commit made, no ref moved)
    let base = match run(&proc, &dir, "git", &["stash".to_owned(), "create".to_owned()], None, 30).await {
        Ok(sha) if !sha.trim().is_empty() => sha.trim().to_owned(),
        _ => run(&proc, &dir, "git", &["rev-parse".to_owned(), "HEAD".to_owned()], None, 10).await.unwrap_or_default().trim().to_owned(),
    };
    let _ = tokio::fs::write(home.join(format!(".sandbox/base-{name}")), base).await;
    let setup = setup_once(&proc, home, &dir, &name).await;
    Ok(api::Seeded { cwd: dir.display().to_string(), setup })
}

/// The project's `.wisp/sandbox.sh`, the first time this sandbox gets the project (a mark in `~/.sandbox`).
async fn setup_once(proc: &Proc, home: &Path, dir: &Path, name: &str) -> Option<String> {
    let script = dir.join(".wisp/sandbox.sh");
    if !tokio::fs::metadata(&script).await.is_ok_and(|m| m.is_file()) {
        return None;
    }
    let mark: PathBuf = home.join(format!(".sandbox/setup-{name}"));
    if tokio::fs::metadata(&mark).await.is_ok() {
        return None;
    }
    let said = match run(proc, dir, "sh", &[".wisp/sandbox.sh".to_owned()], None, 900).await {
        Ok(o) => o,
        Err(e) => format!("setup failed: {e}"),
    };
    let _ = tokio::fs::write(&mark, b"").await;
    Some(said.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect())
}

/// `sandbox.patch` (inside a sandbox): what changed in a project since it came in, new files too, as one binary diff.
pub async fn patch(ctx: &Ctx, home: &Path, cwd: &str) -> Result<api::Patch> {
    let proc = ctx.service::<Proc>()?;
    let dir = PathBuf::from(cwd);
    let name = core::name_of(cwd);
    if !dir.starts_with(home.join("code")) {
        return Err(WireError::invalid("only a project under ~/code has changes to give back"));
    }
    let base = tokio::fs::read_to_string(home.join(format!(".sandbox/base-{name}"))).await.map_err(|_| WireError::not_found("That project didn't come in through a seed."))?;
    // new files count: marked as intended, so the diff has them
    let _ = run(&proc, &dir, "git", &["add".to_owned(), "-N".to_owned(), ".".to_owned()], None, 30).await;
    let diff = run(&proc, &dir, "git", &["diff".to_owned(), base.trim().to_owned(), "--binary".to_owned()], None, 120).await.map_err(|e| WireError::internal(format!("git diff: {e}")))?;
    Ok(api::Patch { patch: diff })
}
