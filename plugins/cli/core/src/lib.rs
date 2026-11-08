//! wisp-cli-core: the command-line frontend without IO (ADR-0022, ADR-0024).
//!
//! - [`verbs`]: `wisp <plugin> <verb>` from the catalogue, flags from the argument type ([`decl`]),
//!   `--help`, `wisp help`, `wisp help <plugin>`; [`completions`] for zsh, bash and fish.
//! - [`blocks`]: the `term.block@1` renderers, one per v1 block type, and the generic one for a type
//!   nobody draws; [`md`] for markdown; [`term`] for colour, links, width and wrapping.
//! - [`attach`]: a task's topic rows in, the live view out (activity, the answer, its questions).
//! - [`human`]: a command's result as text.

pub mod attach;
pub mod blocks;
pub mod completions;
pub mod decl;
pub mod human;
pub mod md;
pub mod term;
pub mod verbs;

pub use blocks::{BUILTIN, IMAGE_MARK, Renderers};
pub use verbs::{Catalogue, Usage, Verb};
pub use wisp_cli_api::{Images, Style};
