//! wisp-proc: the kernel's `proc` service (plan §6.1, ADR-0013). Every child process wisp starts goes
//! through it: `which` (PATH, and on Windows PATHEXT, `.cmd` shims and `.ps1` launchers, as v1's
//! server/proc.js), `spawn` on pipes or a PTY (portable-pty), `exec` to completion, and killing a tree
//! so nothing it started survives (gate G12: process groups on Unix, a Job Object per child on Windows).
//!
//! A child may belong to a scope (a plugin's `ctx.scope()`): cancelling the scope kills its tree.
//!
//! The service is a trait object so an install can swap it (the grid's sandboxed spawner, `sim::SimProc`
//! in tests). A plugin gets it with `ctx.service::<wisp_proc::Proc>()`; the binary provides `local()`.
//!
//! The only `unsafe` in wisp lives in `sys/`: each block is one OS call with a `SAFETY:` comment.

mod child;
pub mod error;
mod local;
mod pipes;
mod pty;
pub mod resolve;
pub mod sim;
mod sys;
mod tree;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub use child::{Child, ChildControl, ChildHandle};
pub use tokio_util::sync::CancellationToken as Scope;

/// The same type as `wisp_kernel::BoxFuture`, named here so this crate needs no wisp crate.
pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
pub use error::{ProcError, Result};
pub use local::LocalProc;

/// The kernel service plugins ask for: `ctx.service::<Proc>()`.
pub type Proc = Arc<dyn ProcService>;

/// The proc service on this computer.
pub fn local() -> Proc {
    Arc::new(LocalProc::new())
}

/// SIGTERM (SIGHUP for a terminal), then SIGKILL for what is left after this long.
pub const KILL_GRACE: Duration = Duration::from_secs(2);
/// The most `exec` keeps of each stream unless told otherwise.
pub const MAX_EXEC_OUTPUT: usize = 32 * 1024 * 1024;

/// A terminal's size. Set when the PTY is made, before the program's first look (v1: `stty size`
/// said `0 0` when the size came after).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

/// The child's environment: the parent's (unless `clear`), minus `remove`, plus `set`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Env {
    pub clear: bool,
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

impl Env {
    /// Exactly these variables and nothing inherited.
    pub fn exactly(vars: impl IntoIterator<Item = (String, String)>) -> Self {
        Self { clear: true, set: vars.into_iter().collect(), remove: Vec::new() }
    }
    #[must_use]
    pub fn with(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.set.push((k.into(), v.into()));
        self
    }
    #[must_use]
    pub fn without(mut self, k: impl Into<String>) -> Self {
        self.remove.push(k.into());
        self
    }
    /// `GIT_OPTIONAL_LOCKS=0` added when `bin` is git and the caller didn't set it: a read wisp makes
    /// (status, diff, a watcher's refresh) must never take `index.lock` from the user's own `git commit`.
    /// Only optional locks go; a write still takes the locks it needs.
    #[must_use]
    pub fn for_program(mut self, bin: &str) -> Self {
        if is_git(bin) && !self.set.iter().any(|(k, _)| k == GIT_OPTIONAL_LOCKS) {
            self.set.push((GIT_OPTIONAL_LOCKS.to_owned(), "0".to_owned()));
        }
        self
    }
    /// The variables the child sees, given the parent's.
    pub fn resolve(&self, parent: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = if self.clear { Vec::new() } else { parent.into_iter().collect() };
        out.retain(|(k, _)| !self.remove.iter().any(|r| r == k));
        for (k, v) in &self.set {
            out.retain(|(x, _)| x != k);
            out.push((k.clone(), v.clone()));
        }
        out
    }
}

pub const GIT_OPTIONAL_LOCKS: &str = "GIT_OPTIONAL_LOCKS";

/// Whether a program is git, by its file name (`git`, `/usr/bin/git`, `C:\\…\\git.exe`).
pub fn is_git(bin: &str) -> bool {
    let name = bin.rsplit(['/', '\\']).next().unwrap_or(bin);
    name.eq_ignore_ascii_case("git") || name.eq_ignore_ascii_case("git.exe")
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOpts {
    /// the folder it runs in; a missing folder fails the spawn (portable-pty would quietly use $HOME)
    pub cwd: Option<PathBuf>,
    pub env: Env,
    /// on a terminal of this size (stdout and stderr are the one terminal stream)
    pub pty: Option<PtySize>,
    /// stdin is `/dev/null` (pipes only; a PTY always has input)
    pub no_stdin: bool,
    /// cancelling it kills the child's tree (a plugin's scope, a request's)
    pub scope: Option<CancellationToken>,
    /// SIGTERM → SIGKILL grace for `kill()` and the scope; `KILL_GRACE` when `None`
    pub grace: Option<Duration>,
    /// Windows: pass args as written (already quoted for cmd.exe)
    pub verbatim: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ExecOpts {
    pub cwd: Option<PathBuf>,
    pub env: Env,
    /// written to stdin, which is then closed
    pub input: Option<Vec<u8>>,
    /// the tree is killed (SIGKILL) after this long; `timed_out` says so
    pub timeout: Option<Duration>,
    /// bytes kept of stdout and of stderr each; `MAX_EXEC_OUTPUT` when 0
    pub max_output: usize,
    pub scope: Option<CancellationToken>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Bytes the child wrote. On a PTY everything is `Stdout`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub stream: Stream,
    pub data: Vec<u8>,
}

/// How a child ended: an exit code, or the signal that ended it (`"SIGTERM"`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

impl Exit {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    /// v1's shell convention: the code, else 128 + the signal's number (129 for SIGHUP).
    pub fn shell_code(&self) -> i32 {
        self.code.unwrap_or_else(|| 128 + self.signal.as_deref().and_then(signal_number).unwrap_or(1))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecResult {
    pub exit: Exit,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    /// more was written than `max_output` kept
    pub truncated: bool,
}

impl ExecResult {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// What a tree kill reached: processes signalled, and how many were still there at the end (0 = G12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct KillReport {
    pub signalled: usize,
    pub survivors: usize,
}

/// The signals wisp sends. `Int` is a key press (^C) for the tree; Windows maps every ending one to
/// `TerminateJobObject`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Signal {
    Term,
    Kill,
    Int,
    Hup,
}

/// `"SIGTERM"` (or `"TERM"`) → its number on this OS.
pub fn signal_number(name: &str) -> Option<i32> {
    sys::signal_number(name)
}

/// The proc service. Every method is cheap to call from async code: blocking work runs off the
/// runtime's workers.
pub trait ProcService: Send + Sync + 'static {
    /// `bin` on PATH (`env`'s PATH when given), as the platform finds it, or `None`.
    fn which(&self, bin: &str, env: Option<Vec<(String, String)>>) -> BoxFuture<'static, Option<PathBuf>>;
    /// Starts `bin args`. A missing program is `Err(ProcError::NotFound)`, never a panic.
    fn spawn(&self, bin: &str, args: &[String], opts: SpawnOpts) -> Result<Child>;
    /// Runs to completion, keeping what it printed (up to `max_output` per stream).
    fn exec(&self, bin: &str, args: &[String], opts: ExecOpts) -> BoxFuture<'static, Result<ExecResult>>;
    /// A program on its own (a terminal app): its own session, no pipes, never killed with wisp.
    fn spawn_detached(&self, bin: &str, args: &[String], opts: SpawnOpts) -> Result<u32>;
    /// Children started and not yet exited.
    fn live(&self) -> usize;
    /// Kills every live tree side by side (one grace period, not one per child). On shutdown.
    fn kill_all(&self, grace: Duration) -> BoxFuture<'static, ()>;
}

/// Output channel depth: a slow reader holds the child back (backpressure) instead of growing a buffer.
pub(crate) const OUTPUT_DEPTH: usize = 64;

pub(crate) fn output_channel() -> (mpsc::Sender<Output>, mpsc::Receiver<Output>) {
    mpsc::channel(OUTPUT_DEPTH)
}

/// macOS: each pid's `phys_footprint` (what Activity Monitor shows as Memory), from one syscall per pid.
/// Pids that are gone or another user's are left out; elsewhere the map is empty (keep RSS).
pub fn footprints(pids: &[u32]) -> std::collections::HashMap<u32, u64> {
    pids.iter().filter_map(|&p| sys::footprint(p).map(|b| (p, b))).collect()
}

/// `sig` to one process that isn't a child of this service (This Mac's Stop on a left-behind process).
/// Refuses pid 0, 1 and wisp itself. Windows: Term and Kill end it, others are unsupported.
pub fn signal_pid(pid: u32, sig: Signal) -> Result<()> {
    if pid == std::process::id() {
        return Err(ProcError::Unsupported("signalling wisp itself"));
    }
    #[cfg(unix)]
    {
        sys::signal_pid(pid, pipes::sig_number(sig))
            .map_err(|e| if e.raw_os_error() == Some(libc::ESRCH) { ProcError::Exited } else { ProcError::Io(e) })
    }
    #[cfg(windows)]
    {
        match sig {
            Signal::Term | Signal::Kill | Signal::Hup => sys::terminate_pid(pid, 1).map_err(ProcError::Io),
            Signal::Int => Err(ProcError::Unsupported("SIGINT on Windows")),
        }
    }
}

/// Is `pid` still running (not a zombie)? One process-table read.
pub fn pid_alive(pid: u32) -> bool {
    sys::processes().is_ok_and(|t| t.iter().any(|p| p.pid == pid && !p.zombie))
}

/// A row of the process table: enough to walk a tree.
pub use sys::ProcInfo;

/// Every process this user can see (pid, parent, group, zombie). Blocking: one table read.
pub fn processes() -> std::io::Result<Vec<ProcInfo>> {
    sys::processes()
}
