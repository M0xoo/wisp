//! wisp.termctx contract (ADR-0023): `wisp "check the error above"` knows what just happened in the terminal.
//!
//! - `termctx.source@1`: one way to read a terminal's recent output: the argv of the terminal's own read command
//!   (`tmux capture-pane`, `wezterm cli get-text`, …) for an environment, or None when that isn't this terminal.
//!   Never the user's command: nothing is run again to see its output. Any plugin may add one.
//! - `termctx.sources {env, lines}`: the sources' read commands for the CLI's terminal, in order. The CLI runs the
//!   first that answers, where the terminal is.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::{Command, Point};

pub const PLUGIN_ID: &str = "wisp.termctx";
/// `termctx.enabled`: off, `wisp` never gathers terminal context.
pub const ENABLED: &str = "termctx.enabled";

pub trait TermSource: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn label(&self) -> &str;
    /// The read command for this terminal, or None when `env` isn't it.
    fn argv(&self, env: &BTreeMap<String, String>, lines: usize) -> Option<Vec<String>>;
}

pub const SOURCE: Point<dyn TermSource> = Point::new("termctx.source", 1);

/// The environment variables a source may look at (the CLI sends only these).
pub const ENV_KEYS: [&str; 8] =
    ["TMUX", "TMUX_PANE", "WEZTERM_PANE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "KITTY_PID", "ITERM_SESSION_ID", "TERM_PROGRAM"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "termctx/")]
pub struct SourcesArgs {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub lines: usize,
}

/// One source that's this terminal, and its read command.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "termctx/")]
pub struct Reader {
    pub id: String,
    pub label: String,
    pub argv: Vec<String>,
}

#[derive(Debug)]
pub struct Sources;
impl Command for Sources {
    const ID: &'static str = "termctx.sources";
    const PERMISSION: Option<&'static str> = Some("termctx:read");
    const READ_ONLY: bool = true;
    type Args = SourcesArgs;
    type Out = Vec<Reader>;
    fn args_ts() -> Option<String> {
        Some(<SourcesArgs as ::ts_rs::TS>::inline(&::ts_rs::Config::default()))
    }
}
