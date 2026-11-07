//! wisp-telemetry-core: the pure half of wisp.telemetry (v1 server/telemetry.js,
//! server/services/telemetry.js, server/services/feedback.js). Who may send, what an event carries, path
//! scrubbing, the queue and the outboxes, what turns and feedback report. Sans-IO: the host posts through
//! the kernel's `net` service, keeps the outboxes, and reads the clock.

pub mod env;
pub mod events;
pub mod feedback;
pub mod queue;
pub mod scrub;
pub mod text;
pub mod turns;

pub use env::{Env, env_disabled, feedback_available, shell_of};
pub use events::{Common, ErrorInfo, PAGE_EVENTS, Props, page_event};
pub use queue::{Telemetry, Tracked};
pub use scrub::{ScrubOptions, frames, scrub};
