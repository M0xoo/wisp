//! wisp.terminal's commands. The HTTP routes (v1's paths) are thin adapters over the same registry;
//! these are for other plugins, the CLI, MCP and the sync layer. None is reachable until a capability
//! set names its permission (`terminal:*`: the user, the kernel, a box; never an agent).

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Command;

use crate::model::{ShellInfo, ShellStarted, TermInfo, TermKind, TerminalApps};

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal, $perm:literal : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

/// `{ ok }`: v1's answer for typing, closing and opening an app.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct Done {
    pub ok: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct KindId {
    #[serde(default)]
    pub kind: TermKind,
    pub id: String,
}

/// Starts a terminal for task `id`, or returns the one still running (one per task and kind). Sizes are
/// clamped (cols 20..500, rows 5..200; 100 × 30 when missing).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct OpenArgs {
    #[serde(default)]
    pub kind: TermKind,
    pub id: String,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<f64>,
    /// a terminal session (v1 services/tui.js): its follow-ups are typed in, not refused
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub tui: bool,
}

/// Types `data` (numbered or not) and/or resizes to `cols × rows`. `ok: false` when nothing runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct InputArgs {
    #[serde(default)]
    pub kind: TermKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<f64>,
}

/// The shell beside task `id`, in its folder (`terminal.folder`, else its cwd). Already running and no
/// `restart`: only resized, `started: false`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct ShellStartArgs {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub restart: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "terminal/")]
pub struct ShellInfoArgs {
    pub id: String,
    /// the request came through the grid's edge or a machine's proxy: no terminal app here for it
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub via_proxy: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "terminal/")]
pub struct AppsArgs {}

/// Opens `argv` in `cwd` in the terminal app from Settings (`wisp` reads as `auto`: the page is no app).
/// Refused (`conflict`) where there is no desktop or the caller came through a proxy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "terminal/")]
pub struct OpenAppArgs {
    pub cwd: String,
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub via_proxy: bool,
}

command!(Open = "terminal.open", "terminal:open": OpenArgs => TermInfo);
command!(Input = "terminal.input", "terminal:input": InputArgs => Done);
command!(Close = "terminal.close", "terminal:close": KindId => Done);
command!(ShellStart = "terminal.shell.start", "terminal:shell": ShellStartArgs => ShellStarted);
command!(OpenApp = "terminal.app.open", "terminal:open": OpenAppArgs => Done);
command!(Get = "terminal.get", "terminal:read": KindId => Option<TermInfo>, read_only);
command!(
    /// The workspace panel's `shell` for task `id`.
    ShellInfoOf = "terminal.shell.info", "terminal:read": ShellInfoArgs => ShellInfo, read_only
);
command!(
    /// Settings → General's terminal list for this computer (only "In wisp" on a wisp Grid box).
    Apps = "terminal.apps", "terminal:read": AppsArgs => TerminalApps, read_only
);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_and_permissions() {
        assert_eq!(
            (Open::ID, Open::PERMISSION),
            ("terminal.open", Some("terminal:open"))
        );
        assert_eq!(ShellStart::PERMISSION, Some("terminal:shell"));
        assert_eq!(
            [
                Get::READ_ONLY,
                ShellInfoOf::READ_ONLY,
                Apps::READ_ONLY,
                Input::READ_ONLY
            ],
            [true, true, true, false]
        );
    }

    #[test]
    fn args_read_as_v1_bodies() {
        let a: InputArgs =
            serde_json::from_value(json!({"id": "s", "data": "x", "seq": 3, "from": "p"}))
                .unwrap_or_default();
        assert_eq!(
            (a.kind, a.seq, a.from.as_deref()),
            (TermKind::Takeover, Some(3), Some("p"))
        );
        let o: OpenArgs =
            serde_json::from_value(json!({"kind": "shell", "id": "s", "argv": ["sh"], "cwd": "/"}))
                .unwrap_or_default();
        assert_eq!((o.kind, o.cols, o.tui), (TermKind::Shell, None, false));
    }
}
