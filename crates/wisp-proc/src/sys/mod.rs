//! The reviewed OS calls (plan §9.2: "`forbid(unsafe_code)` except in `proc`"). Ported from the
//! former wisp-native helper's sys crate (ADR-0009, ADR-0013). The rest of the crate denies
//! `unsafe`; everything it needs from the OS that std doesn't offer lives here behind safe
//! functions. Every `unsafe` block is one call with a `SAFETY:` comment
//! (`clippy::undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block` are denied). Review
//! this folder whenever it changes.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// One row of the process table, enough to walk a tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    /// Process group; 0 on Windows, which has none (Job Objects play that part).
    pub pgid: u32,
    /// Exited but not yet reaped by its parent: it can't run, so it counts as gone.
    pub zombie: bool,
    /// When it started (µs since the epoch on macOS, clock ticks since boot on Linux; 0: unknown).
    /// A pid with the same start is the same process, never a stranger who got the pid again.
    pub start: u64,
}
