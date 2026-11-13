//! The shapes of wisp.lsp on the wire. They are v1's (server/lsp.js, server/routes/lsp.js) field for
//! field, so v1's editor (web/js/features/editor.js) keeps reading them. `ts-rs` exports them under `lsp/`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the editor asks a language server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "lsp/")]
pub enum Op {
    Definition,
    References,
    Hover,
    Diagnostics,
    Rename,
    Completion,
}

impl Op {
    /// v1's order, which its 400 message lists.
    pub const ALL: [Op; 6] = [Op::Definition, Op::References, Op::Hover, Op::Diagnostics, Op::Rename, Op::Completion];

    pub fn as_str(self) -> &'static str {
        match self {
            Op::Definition => "definition",
            Op::References => "references",
            Op::Hover => "hover",
            Op::Diagnostics => "diagnostics",
            Op::Rename => "rename",
            Op::Completion => "completion",
        }
    }

    pub fn parse(s: &str) -> Option<Op> {
        Op::ALL.into_iter().find(|op| op.as_str() == s)
    }
}

/// The languages wisp knows a server for (v1 `SERVERS` keys).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "lsp/")]
pub enum Lang {
    Ts,
    Py,
    Go,
    Rs,
}

impl Lang {
    pub const ALL: [Lang; 4] = [Lang::Ts, Lang::Py, Lang::Go, Lang::Rs];

    pub fn as_str(self) -> &'static str {
        match self {
            Lang::Ts => "ts",
            Lang::Py => "py",
            Lang::Go => "go",
            Lang::Rs => "rs",
        }
    }

    pub fn parse(s: &str) -> Option<Lang> {
        Lang::ALL.into_iter().find(|l| l.as_str() == s)
    }
}

/// A place a name is defined or used, as the editor opens it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lsp/")]
pub struct Hit {
    /// relative to the task's folder, with `/`
    pub path: String,
    /// 1-based
    pub line: u32,
    /// 1-based
    pub col: u32,
    /// the line's text, trimmed, at most 240 characters
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "lsp/")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lsp/")]
pub struct Diagnostic {
    pub line: u32,
    pub col: u32,
    pub severity: Severity,
    /// at most 500 characters
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lsp/")]
pub struct CompletionItem {
    pub label: String,
    /// at most 160 characters
    pub detail: String,
    /// what the editor types: the item's edit, its insert text, or its label
    pub insert: String,
}

/// `POST /sessions/:id/lsp`'s body. Positions are 1-based; `text` is the editor's copy (unsaved edits
/// too), the file on disk when left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lsp/")]
pub struct LspRequest {
    pub op: Op,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub col: Option<u32>,
    /// rename only: a name (letters, digits, `_` and `$`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub new_name: Option<String>,
}

impl LspRequest {
    /// v1: `Number(body.line) || 1`
    pub fn line(&self) -> u32 {
        self.line.filter(|n| *n > 0).unwrap_or(1)
    }
    pub fn col(&self) -> u32 {
        self.col.filter(|n| *n > 0).unwrap_or(1)
    }
}

/// `lsp.ask`'s args: the route's body plus the session it is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lsp/")]
pub struct AskArgs {
    pub id: String,
    #[serde(flatten)]
    pub request: LspRequest,
}

/// What `POST /sessions/:id/lsp` answers. `lsp` is the server's name (`TypeScript`), or null when none
/// is installed for the file's language: the page keeps its text search, and offers Install when
/// `install` names a server wisp can install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "lsp/")]
pub enum LspAnswer {
    NoServer { lsp: (), lang: Option<Lang>, install: Option<String> },
    Diagnostics { lsp: String, diagnostics: Vec<Diagnostic> },
    Hover { lsp: String, hover: String },
    Completion { lsp: String, items: Vec<CompletionItem> },
    Renamed { lsp: String, files: Vec<String>, count: u32 },
    Hits { lsp: String, hits: Vec<Hit> },
}

/// `POST /lsp/install`'s body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lsp/")]
pub struct InstallArgs {
    pub lang: String,
}

/// `{ ok: true }`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lsp/")]
pub struct Installed {
    pub ok: bool,
}
