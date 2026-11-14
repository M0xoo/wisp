//! wisp.crew contract (v1 `server/crew.js`): named, long-lived agents the user keeps on hand
//! ("Ada · CI watcher"). A member is an identity (name, role, avatar), a brief, a schedule (cron, or a
//! wake-up it asked for) and a memory (notebook, log). Its work runs as ordinary tasks, its jobs, several
//! at once; jobs past its `parallel` limit wait in its queue.
//!
//! Members (their schedule, queue, log and links) are rows; their kit (SKILL.md files) stays files the
//! host writes through a small port. Wire shapes are v1's (camelCase), so v1 clients keep working.

pub mod commands;
pub mod events;
pub mod rows;
pub mod share;
pub mod spec;

pub use rows::*;

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.crew";
/// The sync topic every member row is published on.
pub const TOPIC: &str = "crew";

/// Reads (list, view, mentions, layout, next wake).
pub const PERM_READ: &str = "crew:read";
/// Changes to the crew (create, update, remove, import, layout).
pub const PERM_WRITE: &str = "crew:write";
/// Handing a member work (a job, a check-in, an @mention).
pub const PERM_ASSIGN: &str = "crew:assign";
/// Proposing files for a member's kit (`wisp_crew_kit`): nothing changes until the user picks, so a crew member's
/// own job may build its kit.
pub const PERM_PROPOSE: &str = "crew:propose";

pub const MAX_CREW: usize = 12;
pub const MAX_PARALLEL: u32 = 5;
pub const BRIEF_MAX: usize = 4000;
/// What a member is asked to keep its notebook under.
pub const NOTEBOOK_SOFT: usize = 6000;
/// Past this the oldest notebook lines go.
pub const NOTEBOOK_MAX: usize = 12_000;
/// Lines a `remember` adds at most, and how long each may be.
pub const REMEMBER_LINES: usize = 12;
pub const REMEMBER_CHARS: usize = 300;
pub const LOG_MAX: usize = 40;
pub const LINKS_MAX: usize = 20;
/// Waiting jobs per member; the next one is refused with a 429.
pub const QUEUE_MAX: usize = 20;
/// A member's follow-ups per job.
pub const FOLLOW_UPS_MAX: usize = 3;
/// `wakeIn` bounds, in minutes (v1 crew.js:47-48).
pub const WAKE_MIN: i64 = 5;
pub const WAKE_MAX: i64 = 7 * 24 * 60;
/// Kit bounds (v1 web/js/skill-md.js).
pub const KIT_MAX: usize = 24;
pub const KIT_BODY_MAX: usize = 50_000;
pub const KIT_TOTAL_MAX: usize = 200_000;
pub const OFFERS_MAX: usize = 10;
pub const OFFER_FILES: usize = 12;
/// How often the scheduler looks at the crew (v1 crew.js:870).
pub const TICK_MS: u64 = 20_000;

pub const CREW_COLORS: [&str; 8] = ["violet", "teal", "amber", "rose", "sky", "lime", "orange", "indigo"];
/// The harnesses a member may run on (v1 adapters, without wisp's own).
pub const HARNESSES: [&str; 7] = ["claude", "codex", "opencode", "cursor", "antigravity", "grok", "copilot"];
pub const MODES: [&str; 3] = ["plan", "edits", "auto"];

/// A spell's member: the spell owns these fields of its blueprint (Make it mine lets go).
pub const DEFINITION: [&str; 10] = ["name", "role", "avatar", "color", "brief", "cron", "on", "mode", "kit", "team"];
/// A spell changing one of these pauses the member until you've seen the change.
pub const REVIEWED: [&str; 5] = ["brief", "kit", "cron", "on", "mode"];

/// The `WireError.details.status` a refusal carries when v1 answered 429 (the kernel has no such code).
pub const STATUS_TOO_MANY: u16 = 429;
