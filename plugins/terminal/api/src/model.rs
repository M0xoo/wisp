//! The rows the page and other plugins read: a terminal's state and info, the shell panel's summary,
//! the terminal apps Settings lists, and the `terminal.changed` event.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Event;

/// A take over (the task's agent on a terminal, v1 `app.terms`) or the shell beside it (`app.shells`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "terminal/")]
pub enum TermKind {
    #[default]
    Takeover,
    Shell,
}

/// The terminal flow (plan §4.6.3): a STOP while starting cancels the start, and an ended terminal never
/// reopens its dead screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "terminal/")]
pub enum TermState {
    #[default]
    Idle,
    Starting,
    Slow,
    Running,
    Stopping,
    Ended,
    Failed,
}

impl TermState {
    /// A program is on it: input goes in, the task counts as "in a terminal".
    pub fn live(self) -> bool {
        matches!(self, Self::Starting | Self::Slow | Self::Running)
    }
    /// It ended (or never started): a page sees its last screen and its exit code.
    pub fn over(self) -> bool {
        matches!(self, Self::Ended | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "terminal/")]
pub struct TermInfo {
    pub id: String,
    pub kind: TermKind,
    pub state: TermState,
    pub cols: u16,
    pub rows: u16,
    /// always true on a PTY from the proc service; kept for v1 pages (script(1) kept its size)
    pub resizable: bool,
    /// the exit code once it ended; null while it runs
    pub code: Option<i32>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub used_at: i64,
    /// pages streaming it now
    pub clients: u32,
    /// a terminal session's CLI: follow-ups are typed into it, not refused
    pub tui: bool,
}

impl TermInfo {
    /// A take over that refuses follow-ups (two agents on one conversation would trample each other).
    pub fn busy(&self) -> bool {
        self.kind == TermKind::Takeover && self.state.live() && !self.tui
    }
}

/// Numbered input (v1 `Terms.input`): `seq` counted per page (`from`). Plain when either is missing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct InputOrder {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
}

/// Where a task's terminal opens: its worktree, else the project folder (v1 `shellDir`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct TaskFolder {
    pub dir: String,
    /// the folder the task's paths are relative to (worktree root, else cwd)
    pub root: String,
    /// its worktree is gone (merged with its branch): the page says so
    pub gone: bool,
}

/// The workspace panel's `shell` (v1 GET /sessions/:id/workspace).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct ShellInfo {
    /// this computer can run a terminal for the page (not Windows)
    pub supported: bool,
    pub open: bool,
    /// a terminal app can open here (a desktop, not through a proxy)
    pub app: bool,
    /// the shell's name (`zsh`)
    pub name: String,
}

/// v1 POST /sessions/:id/shell's answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct ShellStarted {
    pub ok: bool,
    pub started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gone: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct TerminalApp {
    pub id: String,
    pub label: String,
}

/// Settings → General's list for this computer and the default it starts with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "terminal/")]
pub struct TerminalApps {
    pub terminals: Vec<TerminalApp>,
    pub default_terminal: String,
}

/// A terminal opened, moved state or was forgotten (`gone`). The list row's "In terminal" follows
/// take overs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct Changed {
    pub kind: TermKind,
    pub id: String,
    pub state: TermState,
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gone: bool,
}

impl Event for Changed {
    const TYPE: &'static str = "terminal.changed";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_v1_s() {
        assert_eq!(
            serde_json::to_string(&TermKind::Takeover).ok().as_deref(),
            Some("\"takeover\"")
        );
        assert_eq!(
            serde_json::to_string(&TermState::Stopping).ok().as_deref(),
            Some("\"stopping\"")
        );
        let s = ShellStarted {
            ok: true,
            started: false,
            dir: None,
            gone: None,
        };
        assert_eq!(
            serde_json::to_string(&s).ok().as_deref(),
            Some("{\"ok\":true,\"started\":false}")
        );
    }

    #[test]
    fn only_a_live_non_tui_take_over_is_busy() {
        let mut t = TermInfo {
            id: "s".into(),
            kind: TermKind::Takeover,
            state: TermState::Running,
            cols: 100,
            rows: 30,
            resizable: true,
            code: None,
            started_at: 0,
            used_at: 0,
            clients: 0,
            tui: false,
        };
        assert!(t.busy());
        t.tui = true;
        assert!(!t.busy());
        t.tui = false;
        t.state = TermState::Ended;
        assert!(!t.busy());
    }
}
