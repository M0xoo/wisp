//! wisp-terminal-api: the contract of wisp.terminal, the plugin that runs terminals for the page. Two
//! kinds, one registry each: a take over (the task's agent on a terminal, v1 `app.terms`) and a shell
//! beside the task (the side panel's, v1 `app.shells`). Both stream over SSE exactly as v1 did
//! (`/sessions/:id/term`, `/sessions/:id/shell`).
//!
//! Other plugins reach them through [`TerminalServiceV1`] (runtime's take over and terminal sessions)
//! or the commands; who knows a task's folder contributes to [`FOLDER`] (wisp.worktrees). Types the UI
//! reads derive `ts_rs::TS` and export under `terminal/`.

pub mod commands;
pub mod model;
pub mod points;
pub mod service;

pub use commands::{
    Apps, AppsArgs, Close, Done, Get, Input, InputArgs, KindId, Open, OpenApp, OpenAppArgs,
    OpenArgs, RunInfoArgs, RunInfoOf, RunStart, RunStartArgs, ShellInfoArgs, ShellInfoOf, ShellStart, ShellStartArgs,
};
pub use model::{
    Changed, InputOrder, RunInfo, RunStarted, ShellInfo, ShellStarted, TaskFolder, TermInfo, TermKind, TermState,
    TerminalApp, TerminalApps,
};
pub use points::{FOLDER, FolderSource};
pub use service::{PERMISSIONS, TerminalService, TerminalServiceV1, permission};

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.terminal";

/// v1's 409 for a follow-up (or a compact, a rerun, a queued send) while the task's agent is open in a
/// terminal: two agents on one conversation would trample each other.
pub const BUSY_MESSAGE: &str =
    "This task is open in a terminal. Carry on there, or end the terminal first.";

/// v1 settings keys (`config.defaults.terminal`, `config.defaults.terminalCommand`).
pub mod settings {
    /// which terminal a take over and "open in terminal" use: `wisp` (the page), `auto`, or an app id
    pub const TERMINAL: &str = "terminal";
    /// the custom command line, with `{cwd}`, `{cmd}` and `{line}`
    pub const COMMAND: &str = "terminal.command";
}
