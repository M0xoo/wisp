//! What the rest of the grid asks of hostd: the contract between the edge (and the inbox, sandboxes,
//! the CLI) and whatever starts and stops boxes. `hostd::Hostd` implements it in-process; the
//! `wisp-grid-hostd` binary serves the same trait on a unix socket for an edge that runs apart.
//!
//! Use is the one subtle part: `ensure` (unless `wake`) and a `begin` guard with `touch: true` count as
//! use of a box, and keep it up. A channel's message (inbox delivery) opens `begin(…, false)`, so it
//! never touches `lastTouch` or `lastActivityAt` (plan §7.2.3: channels never keep a box awake).
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::rows::BoxUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BoxState {
    #[default]
    Stopped,
    Queued,
    Starting,
    Running,
    Stopping,
}

impl BoxState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Queued => "queued",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
        }
    }
}

/// A box changed state (hostd's `change` event): what account pages and the instances table follow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxChange {
    pub user: BoxUserWire,
    pub state: BoxState,
    /// the state, or what happened: "failed", "oom", "idle", "evicted", "woke"…
    pub event: String,
    pub started_at: Option<i64>,
    pub stopped_at: Option<i64>,
    pub next_wake_at: Option<i64>,
    pub last_active_at: Option<i64>,
    pub error: String,
}

/// `BoxUser` on the wire (hostd's socket, change events).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoxUserWire {
    pub id: String,
    pub handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

impl From<&BoxUser> for BoxUserWire {
    fn from(u: &BoxUser) -> Self {
        Self {
            id: u.id.clone(),
            handle: u.handle.clone(),
            sandbox: u.sandbox.clone(),
            owner: u.owner.clone(),
        }
    }
}

impl From<BoxUserWire> for BoxUser {
    fn from(u: BoxUserWire) -> Self {
        Self {
            id: u.id,
            handle: u.handle,
            sandbox: u.sandbox,
            owner: u.owner,
        }
    }
}

/// A request on its way to a box: the box is never stopped for idleness while one is open. Dropping it
/// ends the request (and, if it was opened with `touch`, counts as use).
pub struct Busy(Option<Box<dyn FnOnce() + Send>>);

impl Busy {
    pub fn new(done: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(done)))
    }
    /// For a box hostd doesn't know: nothing to end.
    pub fn none() -> Self {
        Self(None)
    }
}

impl std::fmt::Debug for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Busy")
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// Where a box listens once it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Running {
    pub port: u16,
}

#[async_trait::async_trait]
pub trait BoxHost: Send + Sync + std::fmt::Debug {
    fn state(&self, user_id: &str) -> BoxState;
    /// Where its wisp listens, once running.
    fn port(&self, user_id: &str) -> Option<u16>;
    /// Use of the box, now.
    fn touch(&self, user_id: &str);
    /// A request on its way to the box. `touch: false` for one that mustn't count as use once it's
    /// over (a channel's message).
    fn begin(&self, user_id: &str, touch: bool) -> Busy;
    /// Running, or started and waited for. Several callers share one start. `wake`: a scheduled task's
    /// (or a channel's), which waits behind people, never evicts anyone and doesn't count as use.
    async fn ensure(&self, user: &BoxUser, wake: bool) -> Result<Running>;
    /// Stop it (its home and tasks are kept). False if it wasn't running.
    async fn stop(&self, user_id: &str, reason: &str) -> Result<bool>;
    /// Stop it for good and delete its home (account or sandbox deleted).
    async fn remove(&self, user: &BoxUser) -> Result<()>;
    /// At start: a box that was asleep with a scheduled task due wakes for it.
    fn restore(&self, user: &BoxUser, next_wake_at: Option<i64>);
    /// How many boxes may run at once.
    fn capacity(&self) -> usize;
    /// Most boxes up at once, and starts that had to queue, since the last call (load samples).
    fn take_peak(&self) -> (usize, usize);
    /// Each state change, as it happens.
    fn changes(&self) -> tokio::sync::broadcast::Receiver<BoxChange>;
    /// Whether pages in boxes show at `p<port>--<handle>` (containers by default).
    fn previews(&self) -> bool;
    /// Stop everything (shutdown).
    async fn close(&self);
}
