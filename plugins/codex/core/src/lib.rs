//! wisp.codex core (sans-IO): `codex exec --json`'s stream parser (v1 adapters/codex.js `run()`'s
//! `onJson`/`onItem`/`onClose`), the turn's token count (`turnUsage`), the shell unwrapping and the
//! argv builder. No file, clock or process here: the host's driver runs the tracker steps, the host's
//! launch writes the lean base prompt as a launch file.

mod argv;
mod parser;
mod shell;
mod usage;

pub use argv::{ASK_TIMEOUT_S, CodexArgs, LEAN_BASE, LEAN_FEATURES, args, toml};
pub use parser::{CodexOptions, CodexParser, describe_mcp};
pub use shell::unwrap_shell;
pub use usage::turn_usage;
