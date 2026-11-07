//! wisp.later contract: work wisp does at a time you or an agent set (v1 server/later.js, design/later.md).
//!
//! - **follow-up**: an entry on a task, sent into that same task when due, so its agent carries on
//!   with its whole conversation (the agent's `resume_later`, or Send later in the reply box).
//! - **reminder**: an entry with `remind` brings that task back to Needs you with its text; a plan of
//!   kind `reminder` becomes a small task of its own, with no agent.
//! - **task plan**: a launch body started when due, or a draft with no time (`/draft`), or one that
//!   waits for another task to be done (`/after`).
//!
//! Entries and plans are wisp.later's rows; a task's entries are mirrored into its ext slot
//! `ext["wisp.later"]` ([`LaterExt`]) so the list row shows them. Shapes are v1's (camelCase).
//!
//! A goal round that waits for the plan is an entry with `goal` (by `wisp`): wisp.later never sends it
//! itself, it publishes [`events::GoalRoundDue`] and wisp.goal takes it from there, so this crate names
//! no other plugin.

pub mod commands;
pub mod events;
pub mod model;

pub use commands::*;
pub use events::*;
pub use model::*;

/// The plugin id (manifest `id`), also the ext slot it writes.
pub const PLUGIN_ID: &str = "wisp.later";

/// The soonest a new entry may be: a minute from now (v1 later.js:20).
pub const MIN_MS: i64 = 60_000;
/// The latest the user may schedule: a month ahead.
pub const MAX_MS: i64 = 30 * 24 * 3_600_000;
/// The latest an agent may schedule its own wake-up: a week ahead.
pub const AGENT_MAX_MS: i64 = 7 * 24 * 3_600_000;
/// Pending entries on one task (v1 later.js:22).
pub const PER_TASK: usize = 5;
/// An agent's wake-ups in a row with no word from the user (v1 later.js:23).
pub const CHAIN_MAX: u32 = 10;
/// Later than this, the agent is told it is late (v1 later.js:24).
pub const LATE_MS: i64 = 2 * 60_000;
/// Later than this, nothing just runs: the user decides (v1 later.js:25).
pub const MISSED_MS: i64 = 24 * 3_600_000;
/// A restart with a backlog doesn't start a dozen runs at once (v1 later.js:26).
pub const PER_TICK: usize = 3;
/// The retry look while something due waits on a busy task or the per-look cap.
pub const TICK_MS: i64 = 20_000;
/// The longest text an entry or plan keeps.
pub const TEXT_MAX: usize = 4000;
/// Attachments one follow-up carries at most.
pub const FILES_MAX: usize = 20;

/// The follow-up that carries a task on after a usage limit: the limit card's Wait until, and wisp's
/// own with Settings → Wait for the reset on. The page knows the card was answered by this text.
pub const LIMIT_CARRY_ON: &str = "Carry on from where the last run stopped at the usage limit.";

/// Who scheduled an entry: the user (never held back by the plan, kept on Mark done).
pub const BY_USER: &str = "user";
/// An agent's own wake-up (`resume_later`).
pub const BY_AGENT: &str = "agent";
/// wisp itself: a goal round waiting for the plan, the carry-on at a limit.
pub const BY_WISP: &str = "wisp";
