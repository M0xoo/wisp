//! wisp.opencode core (sans-IO): `opencode run --format json`'s stream parser (v1 adapters/opencode.js
//! `run()`), its tool sentences, the argv and the inline config (`OPENCODE_CONFIG_CONTENT`) a run
//! carries. No file, clock or process here: the host's driver runs the tracker steps.

mod argv;
mod describe;
mod parser;

pub use argv::{OpencodeArgs, args, config, has_key, major_version};
pub use describe::describe_tool;
pub use parser::{OpencodeOptions, OpencodeParser, RATE_LIMIT_GRACE_MS};
