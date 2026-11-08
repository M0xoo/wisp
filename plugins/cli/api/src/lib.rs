//! wisp-cli-api: the contract of wisp.cli, the command-line frontend (ADR-0022, ADR-0024).
//!
//! - `cli.catalogue`: the commands the caller may run, with their titles and argument types. The CLI
//!   builds `wisp <plugin> <verb>` from it, so it can't fall behind the GUI.
//! - `term.block@1`: a block type's terminal renderer. Both the CLI and the TUI draw answers with it;
//!   a plugin that adds a block type contributes one (or gets the generic summary).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{Command, CommandInfo, Point};

pub const PLUGIN_ID: &str = "wisp.cli";

/// The catalogue: every command the caller's capability set lets it run, sorted by id.
#[derive(Debug)]
pub struct Catalogue;
impl Command for Catalogue {
    const ID: &'static str = "cli.catalogue";
    const PERMISSION: Option<&'static str> = Some("cli:catalogue");
    const READ_ONLY: bool = true;
    type Args = Value;
    type Out = Vec<CommandInfo>;
}

/// How the terminal draws: its width, whether it takes colour (not under `NO_COLOR` or a pipe),
/// OSC 8 links, and an inline image protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Style {
    pub width: usize,
    pub color: bool,
    pub links: bool,
    pub images: Images,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Images {
    None,
    /// `iTerm2`'s (and `WezTerm`'s) `OSC 1337 File=`
    Iterm,
    /// kitty's graphics protocol
    Kitty,
}

impl Style {
    /// Plain text: no colour, no escapes (pipes, `NO_COLOR`, goldens).
    pub const fn plain(width: usize) -> Self {
        Self { width, color: false, links: false, images: Images::None }
    }
    pub const fn color(width: usize) -> Self {
        Self { width, color: true, links: true, images: Images::None }
    }
}

/// A block's terminal renderer: the block's JSON and the style in, lines out (each at most
/// `style.width` columns wide, escapes aside).
pub trait TermBlock: Send + Sync {
    /// the block types it draws (`"stats"`, a plugin's own)
    fn types(&self) -> &[&str];
    fn render(&self, block: &Value, style: &Style) -> Vec<String>;
}

pub const TERM_BLOCK: Point<dyn TermBlock> = Point::new("term.block", 1);
