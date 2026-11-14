//! `runtime.envmask@1` (ADR-0054): .env values in another plugin's own data about a task, hidden as it leaves the
//! server. wisp.runtime is the one that knows what each task's turns read (ADR-0050), so it provides this; a plugin
//! that keeps agent-written text about a task in its own kinds (wisp.goal's `goal_run`: a judge's answer and why)
//! passes that text through it in its own `kernel.egress` view. A built-in uses it as any plugin would (ADR-0003).
//! Additive (2026-11-14).

use serde_json::Value;
use wisp_kernel::Service;

/// How a plugin masks what an agent wrote about a task. Masking only takes away, so it needs no permission and no
/// call; it does no IO (a view calls it for every row that leaves).
pub trait EnvMask: Send + Sync + 'static {
    /// `v` (a string, or a subtree of a plugin's own row: an answer, a reason, a turn-like `{text, activity}`)
    /// as it leaves, unless Settings → Privacy → Hide .env values is off: steps under `activity` by the .env step
    /// rules, a raw answer text's .env blocks, then every string against the values task `task` read and every
    /// .env-shaped line. When what the task read isn't in memory, or `task` is `None` (a patch that can't say
    /// whose it is), every text in `v` is hidden (fail closed); the task's values are read back for the next send.
    /// True when it changed.
    fn mask(&self, task: Option<&str>, v: &mut Value) -> bool;
}

/// The service contract, requested by contract (`runtime.envmask@^1`).
#[derive(Debug)]
pub struct EnvMaskService;

impl Service for EnvMaskService {
    const ID: &'static str = "runtime.envmask";
    const MAJOR: u32 = 1;
    type Api = dyn EnvMask;
}
