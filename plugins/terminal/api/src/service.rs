//! The service `terminal.service@1`: a handle on the registries for other plugins. wisp.runtime's take
//! over opens the task's agent with it (`POST /sessions/:id/takeover` stays a runtime route: it needs
//! the harness's resume command), and checks `get(..).busy()` before a compact, a rerun or a queued
//! send. Every method takes the `Call` first and checks its permission (plan §6.11.1).

use wisp_kernel::{BoxFuture, Call, Result, Service};

use crate::commands::OpenArgs;
use crate::model::{InputOrder, TermInfo, TermKind};

#[derive(Debug)]
pub struct TerminalServiceV1;

impl Service for TerminalServiceV1 {
    const ID: &'static str = "terminal.service";
    const MAJOR: u32 = 1;
    type Api = dyn TerminalService;
}

/// Each method and the permission it requires. A test checks every method refuses without it.
pub const PERMISSIONS: &[(&str, &str)] = &[
    ("open", "terminal:open"),
    ("get", "terminal:read"),
    ("input", "terminal:input"),
    ("resize", "terminal:input"),
    ("close", "terminal:close"),
    ("active", "terminal:read"),
    ("inline", "terminal:read"),
    ("open_app", "terminal:open"),
];

/// The permission `method` requires, or None for a method that isn't part of the service.
pub fn permission(method: &str) -> Option<&'static str> {
    PERMISSIONS.iter().find(|(m, _)| *m == method).map(|(_, p)| *p)
}

pub trait TerminalService: Send + Sync + 'static {
    /// Starts one, or returns the one still running (one per task and kind). A program that can't start
    /// is an answer (`state: failed`, code 127, wisp's line on its screen), not an error.
    fn open(&self, call: &Call, args: OpenArgs) -> Result<TermInfo>;
    fn get(&self, call: &Call, kind: TermKind, id: &str) -> Result<Option<TermInfo>>;
    /// false: nothing runs there
    fn input(&self, call: &Call, kind: TermKind, id: &str, data: &str, order: InputOrder) -> Result<bool>;
    fn resize(&self, call: &Call, kind: TermKind, id: &str, cols: f64, rows: f64) -> Result<bool>;
    /// Hangs a live one up (a start in progress is cancelled); the registry forgets it at once.
    fn close(&self, call: &Call, kind: TermKind, id: &str) -> Result<bool>;
    /// Running terminals a page watches or someone used in the last 15 minutes (a cloud computer
    /// stays up for them, v1 ACTIVE_MS).
    fn active(&self, call: &Call) -> Result<u32>;
    /// A take over opens in the page (Settings says "In wisp", or "Auto" with no desktop here).
    fn inline(&self, call: &Call) -> BoxFuture<'static, Result<bool>>;
    /// Opens `argv` in `cwd` in the terminal app from Settings (a take over that isn't inline).
    fn open_app(&self, call: &Call, cwd: &str, argv: &[String]) -> BoxFuture<'static, Result<()>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_method_has_a_permission() {
        for m in ["open", "get", "input", "resize", "close", "active", "inline", "open_app"] {
            assert!(permission(m).is_some_and(|p| p.starts_with("terminal:")), "{m}");
        }
        assert_eq!(permission("nope"), None);
    }
}
