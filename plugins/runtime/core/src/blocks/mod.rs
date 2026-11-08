//! The fenced `wisp` block: parse (forgiving), check (built-ins + `runtime.block@1`), render to markdown.

pub mod check;
pub mod diff;
pub mod hunks;
pub(crate) mod js;
pub mod map_spec;
pub mod parse;
pub mod render;

pub use check::{BUILTIN_BLOCKS, check, presentation};
pub use parse::{PARSER_VERSION, Parsed, hero_of, parse};
pub use render::{blocks_to_markdown, session_to_markdown};
