//! Running git: always through the proc service (`wisp_proc::Proc`), async, with the quiet environment
//! (edge case Git 1) and git's full path found once (edge case Git 2: on macOS `/usr/bin/git` is an xcrun
//! shim that costs ~200 ms a call). Nothing here blocks a runtime thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::OnceCell;
use tracing::Instrument;
use wisp_git_core::{QUIET_ENV, READ_PREFIX};
use wisp_proc::{Env, ExecOpts, ExecResult, Proc, ProcError};

use crate::error::GitError;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// What one git call needs beyond its args.
#[derive(Debug, Clone, Default)]
pub struct Opts {
    pub timeout: Option<Duration>,
    pub env: Vec<(String, String)>,
    pub input: Option<Vec<u8>>,
    /// stdout kept at most (0: wisp-proc's 32 MB)
    pub max_output: usize,
}

impl Opts {
    pub fn timeout(secs: u64) -> Self {
        Self {
            timeout: Some(Duration::from_secs(secs)),
            ..Self::default()
        }
    }
}

/// The git (and gh) runner shared by every repo handle.
pub struct Git {
    proc: Proc,
    bin: OnceCell<String>,
    /// tests point it at a git of their choosing; v1's `WISP_GIT_BIN`
    fixed: Option<String>,
}

impl std::fmt::Debug for Git {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Git")
            .field("bin", &self.bin.get())
            .finish_non_exhaustive()
    }
}

impl Git {
    pub fn new(proc: Proc, fixed: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            proc,
            bin: OnceCell::new(),
            fixed,
        })
    }

    pub fn proc(&self) -> &Proc {
        &self.proc
    }

    /// git's full path, resolved once: a bare `git` walks PATH on every spawn.
    pub async fn bin(&self) -> String {
        if let Some(f) = &self.fixed {
            return f.clone();
        }
        self.bin
            .get_or_init(|| async {
                let found = self
                    .proc
                    .which("git", None)
                    .await
                    .map(|p| p.to_string_lossy().into_owned());
                let on_path: Vec<String> = found.into_iter().collect();
                let xcode = xcode_git().await;
                wisp_git_core::base::pick_git(&on_path, std::env::consts::OS, xcode.as_deref())
                    .unwrap_or_else(|| "git".into())
            })
            .await
            .clone()
    }

    /// Runs `git args` in `cwd`. Ok with the result whatever the exit code; Err only when it couldn't run.
    pub async fn exec(&self, cwd: &Path, args: &[String], o: Opts) -> Result<ExecResult, GitError> {
        let bin = self.bin().await;
        self.exec_bin(&bin, cwd, args, o).await
    }

    pub async fn exec_bin(
        &self,
        bin: &str,
        cwd: &Path,
        args: &[String],
        o: Opts,
    ) -> Result<ExecResult, GitError> {
        let mut env = Env::default();
        for (k, v) in QUIET_ENV {
            env = env.with(*k, *v);
        }
        for (k, v) in o.env {
            env = env.with(k, v);
        }
        let opts = ExecOpts {
            cwd: Some(cwd.to_path_buf()),
            env,
            input: o.input,
            timeout: Some(o.timeout.unwrap_or(DEFAULT_TIMEOUT)),
            max_output: o.max_output,
            scope: None,
        };
        let span = tracing::debug_span!(
            "git",
            cmd = args
                .iter()
                .find(|a| !a.starts_with('-') && !a.contains('='))
                .map_or("", String::as_str)
        );
        // wisp-proc's exec forks on its blocking pool: nothing here blocks the runtime
        let started = self.proc.exec(bin, args, opts);
        started.instrument(span).await.map_err(|e| match e {
            ProcError::NotFound(b) => GitError::NotInstalled(b),
            ProcError::NoFolder(d) => GitError::NoFolder(d),
            other => GitError::Spawn(other.to_string()),
        })
    }

    /// Runs and requires exit 0: stdout as text (trailing whitespace trimmed, as v1's `run()`).
    pub async fn run(&self, cwd: &Path, args: &[String], o: Opts) -> Result<String, GitError> {
        let r = self.exec(cwd, args, o).await?;
        check(&r)?;
        Ok(r.stdout_text().trim_end().to_owned())
    }

    /// A read: `READ_PREFIX` first; exit 0 required.
    pub async fn read(&self, cwd: &Path, args: &[&str]) -> Result<String, GitError> {
        self.run(cwd, &read_args(args), Opts::default()).await
    }

    /// A read whose failure means "not there": "" instead of an error (v1's `quiet()`).
    pub async fn quiet(&self, cwd: &Path, args: &[&str]) -> String {
        self.read(cwd, args).await.unwrap_or_default()
    }

    /// A read keeping stdout exactly (patches end on a blank context line; paths may end in spaces).
    pub async fn raw(&self, cwd: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let r = self.exec(cwd, &read_args(args), Opts::default()).await?;
        check(&r)?;
        Ok(r.stdout)
    }
}

pub fn read_args(args: &[&str]) -> Vec<String> {
    READ_PREFIX
        .iter()
        .chain(args)
        .map(|s| (*s).to_owned())
        .collect()
}

pub fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

/// Exit 0, or the reason git gave.
pub fn check(r: &ExecResult) -> Result<(), GitError> {
    if r.timed_out {
        return Err(GitError::TimedOut);
    }
    if r.exit.success() {
        return Ok(());
    }
    let fallback = format!("exit {}", r.exit.shell_code());
    Err(GitError::Failed {
        code: r.exit.code,
        why: wisp_git_core::porcelain::why(&r.stderr_text(), &fallback, false),
    })
}

/// The developer folder xcode-select points at, read from its link (no xcrun: it blocked boot).
async fn xcode_git() -> Option<String> {
    if std::env::consts::OS != "macos" {
        return None;
    }
    let dir = tokio::fs::canonicalize("/var/db/xcode_select_link")
        .await
        .ok()?;
    let git: PathBuf = dir.join("usr/bin/git");
    tokio::fs::metadata(&git)
        .await
        .ok()
        .filter(std::fs::Metadata::is_file)?;
    Some(git.to_string_lossy().into_owned())
}
