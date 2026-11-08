//! wisp-harness-kit: what every harness runner shares (v1 `server/adapters/common.js` and
//! `commands.js`). Everything here is sans-IO (plan §3.1 rule 3): parsers are machines fed lines and
//! an exit ([`parser::LineParser`]); where they need the disk they emit an [`parser::IoStep`] the
//! host's driver runs in place. The events are v1's, field for field ([`event::HarnessEvent`]);
//! `wisp-runtime-api`'s contract types are mapped from them in each host crate.

pub mod commands;
pub mod detect;
pub mod drive;
pub mod event;
pub mod golden;
pub mod js;
pub mod lines;
pub mod parser;
pub mod paths;
pub mod protocol;
pub mod re;
pub mod text;
pub mod tracker;

pub use commands::describe_command;
pub use drive::{Disk, DiskFuture, Driver};
pub use event::{
    BillingKind, Change, Edit, HarnessEvent, LimitWindow, Limits, Stats, Tool, ToolKind, TurnResult,
};
pub use lines::{LineSplitter, json_line};
pub use parser::{Exit, IoStep, LineParser, NoDisk, Out, ReplayIo, replay};
pub use paths::{MAX_SNAPSHOT, RunPaths, rel, rel_value};
pub use re::Re;
pub use text::{clip, clip_value, flatten};
