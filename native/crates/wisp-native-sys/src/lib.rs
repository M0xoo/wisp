//! The reviewed OS calls of wisp-native (plan §9.2: "`forbid(unsafe_code)` except in `proc`").
//!
//! The binary crate forbids `unsafe`; everything it needs from the OS that std doesn't offer lives
//! here, behind safe functions. Every `unsafe` block is one call with a `SAFETY:` comment
//! (`clippy::undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block` are denied).

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
}
