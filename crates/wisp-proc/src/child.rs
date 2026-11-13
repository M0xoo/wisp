//! A started child: a cheap, cloneable handle (input, resize, signals, kill, exit) and its output.
//! The handle is the same whoever made the child (`LocalProc`, `sim::SimProc`, the grid's spawner):
//! each provides a `ChildControl`.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::BoxFuture;

use crate::{Exit, KillReport, Output, PtySize, Result, Signal};

/// What a proc implementation does for one child. Every method returns at once; `kill` resolves when
/// the tree is gone (or the survivors are counted).
pub trait ChildControl: Send + Sync + 'static {
    /// Queues bytes for its input; never blocks on a child that stopped reading.
    fn write(&self, data: Vec<u8>) -> Result<()>;
    /// End of input: stdin closes (pipes), or ^D is typed (a PTY).
    fn close_stdin(&self);
    fn resize(&self, size: PtySize) -> Result<()>;
    /// `sig` to the root only, or (`tree`) to everything it started. Returns at once.
    fn signal(&self, sig: Signal, tree: bool) -> Result<()>;
    /// `sig` to the tree, `grace` to go, SIGKILL for what is left, and wait until it is gone.
    fn kill(&self, sig: Signal, grace: Duration) -> BoxFuture<'static, KillReport>;
}

/// A handle on a child. Clone it freely: every clone speaks for the same process.
#[derive(Clone)]
pub struct ChildHandle {
    pid: u32,
    pty: bool,
    grace: Duration,
    control: Arc<dyn ChildControl>,
    exit: watch::Receiver<Option<Exit>>,
}

impl fmt::Debug for ChildHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChildHandle")
            .field("pid", &self.pid)
            .field("pty", &self.pty)
            .field("exit", &*self.exit.borrow())
            .finish_non_exhaustive()
    }
}

impl ChildHandle {
    /// For proc implementations: `exit` holds `Some` once the child has exited and its output drained.
    pub fn new(pid: u32, pty: bool, grace: Duration, control: Arc<dyn ChildControl>, exit: watch::Receiver<Option<Exit>>) -> Self {
        Self { pid, pty, grace, control, exit }
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn is_pty(&self) -> bool {
        self.pty
    }
    pub fn write(&self, data: impl Into<Vec<u8>>) -> Result<()> {
        self.control.write(data.into())
    }
    pub fn close_stdin(&self) {
        self.control.close_stdin();
    }
    pub fn resize(&self, size: PtySize) -> Result<()> {
        self.control.resize(size)
    }
    pub fn signal(&self, sig: Signal, tree: bool) -> Result<()> {
        self.control.signal(sig, tree)
    }
    /// Ends the whole tree: SIGHUP for a terminal (what closing one sends), SIGTERM otherwise, then
    /// SIGKILL after the spawn's grace.
    pub fn kill(&self) -> BoxFuture<'static, KillReport> {
        let sig = if self.pty { Signal::Hup } else { Signal::Term };
        self.control.kill(sig, self.grace)
    }
    /// SIGKILL the tree now.
    pub fn kill_now(&self) -> BoxFuture<'static, KillReport> {
        self.control.kill(Signal::Kill, Duration::ZERO)
    }
    pub fn kill_with(&self, sig: Signal, grace: Duration) -> BoxFuture<'static, KillReport> {
        self.control.kill(sig, grace)
    }
    /// How it ended, once it has.
    pub fn exit(&self) -> Option<Exit> {
        self.exit.borrow().clone()
    }
    pub fn running(&self) -> bool {
        self.exit.borrow().is_none()
    }
    /// Resolves once it exited and its output has drained (the last chunk is sent before this).
    pub fn exited(&self) -> BoxFuture<'static, Exit> {
        let mut rx = self.exit.clone();
        Box::pin(async move {
            match rx.wait_for(Option::is_some).await {
                Ok(v) => v.clone().unwrap_or_default(),
                // The implementation went away without saying: count it as ended.
                Err(_) => Exit::default(),
            }
        })
    }
}

/// A child and its output. `output` ends (`None`) after the last chunk, before `exited` resolves.
#[derive(Debug)]
pub struct Child {
    pub handle: ChildHandle,
    pub output: mpsc::Receiver<Output>,
}

impl Child {
    pub fn pid(&self) -> u32 {
        self.handle.pid()
    }
    pub fn split(self) -> (ChildHandle, mpsc::Receiver<Output>) {
        (self.handle, self.output)
    }
}

/// Ties a child to a scope: cancelling the scope kills its tree. The watcher ends with the child.
pub(crate) fn tie_to_scope(handle: &ChildHandle, scope: Option<CancellationToken>) {
    let Some(scope) = scope else { return };
    let handle = handle.clone();
    tokio::spawn(async move {
        tokio::select! {
            () = scope.cancelled() => {
                let report = handle.kill().await;
                tracing::debug!(pid = handle.pid(), signalled = report.signalled, survivors = report.survivors, "scope ended: tree killed");
            }
            _ = handle.exited() => {}
        }
    });
}
