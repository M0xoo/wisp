//! A harness's static description, what detect found, and signing in (read by wisp.accounts).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::Mode;

// ---------- static description ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct HarnessModel {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hint: Option<String>,
    /// this model's own reasoning levels (wins over the harness's)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub efforts: Vec<String>,
}

/// What v1 adapters declared as fields. Plain data, read without running anything.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // v1's adapter flags, one for one
pub struct HarnessInfo {
    pub id: String,
    pub name: String,
    pub models: Vec<HarnessModel>,
    /// reasoning levels for every model; empty if the CLI has none
    #[serde(default)]
    pub efforts: Vec<String>,
    /// how the agent sees wisp's ask tool; None: it can't take MCP, ask with a question block
    #[serde(default)]
    pub ask_tool: Option<String>,
    /// its permission prompts go to wisp's `approve` MCP tool (live approval); needs `permission()`
    #[serde(default)]
    pub approve_tool: Option<String>,
    /// `gate: true` really stops every write until wisp answers (a side discussion may edit)
    #[serde(default)]
    pub side_gate: bool,
    /// `resume_id` + `fork: true` works on a copy of that conversation (/btw)
    #[serde(default)]
    pub fork: bool,
    /// it reports its own version per run (`cli` events): the runtime never takes detect's for it
    #[serde(default)]
    pub reports_cli: bool,
    /// `resume_command` with `session_id` names the new conversation (terminal sessions resume it)
    #[serde(default)]
    pub session_ids: bool,
    /// it takes a system prompt by flag; false: the runtime's prompt is put ahead of the first prompt
    #[serde(default)]
    pub system_prompt_flag: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessFound {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// overrides the static model list
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<HarnessModel>>,
    /// thinking levels this install reports: wins over `HarnessInfo::efforts`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<String>>,
    /// opencode: a provider is signed in
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_key: Option<bool>,
    /// Some(false): installed but signed out, and no key in the env signs it in
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
    /// the program it found (harness watch pins it; the launch uses it)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SetupTip {
    pub tip: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOverride {
    pub label: String,
    pub note: String,
}

/// What a live approval is about (v1 `permission(tool, input, cwd)`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionAsk {
    pub tool: String,
    pub action: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeOptions {
    pub resume_id: Option<String>,
    pub model: String,
    pub effort: String,
    pub cwd: String,
    /// cwd is a folder wisp made (scratch, worktree): start without asking to trust it
    pub trusted: bool,
    pub prompt: Option<String>,
    pub session_id: Option<String>,
    pub mode: Option<Mode>,
    pub system_prompt: Option<String>,
    pub dirs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCommand {
    pub argv: Vec<String>,
    /// it can't take the prompt as an argument: wisp types it in
    #[serde(default)]
    pub types_prompt: bool,
}

// ---------- signing in (read by wisp.accounts) ----------

/// Signing in from wisp (v1 agent-login.js LOGINS). Plain data; the matchers are trait methods.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessLogin {
    pub bin: String,
    /// `WISP_<ID>_BIN` overrides `bin`
    pub bin_env: String,
    pub args: Vec<String>,
    /// the sign-out arguments; empty: the CLI has none (wisp.accounts removes its login folder)
    pub logout: Vec<String>,
    pub status: Vec<String>,
    /// env vars that sign the CLI in without a login
    pub keys: Vec<String>,
    /// the login only asks on a terminal
    #[serde(default)]
    pub tty: bool,
    #[serde(default)]
    pub extra_env: BTreeMap<String, String>,
    /// not a harness (gh): a tool wisp signs in to for another feature
    #[serde(default)]
    pub tool: bool,
}

/// Several accounts: the folder the CLI keeps its login in (v1 accounts.js HOMES).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAccounts {
    /// `CLAUDE_CONFIG_DIR`, `CODEX_HOME`
    pub env: String,
    /// the CLI's own folder under the user's home (`.claude`): the default account
    pub home_dir: String,
    /// names in its folder that belong to the login, never linked into another account's folder
    pub own: Vec<String>,
    /// a conversation started on one account resumes on another
    pub resumes: bool,
    /// the provider's own way past a limit
    pub extra: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyProvider {
    pub id: String,
    pub name: String,
}

/// Signing in with an API key pasted into wisp (v1 agent-login.js KEYS).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessKeys {
    pub env: String,
    pub url: String,
    pub providers: Vec<KeyProvider>,
    /// where the CLI keeps keys, relative to the home
    pub file: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderPart {
    pub label: String,
    pub path: String,
}

/// The folders it keeps on disk (This Mac → harness disk, v1 harness-disk.js).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessFolders {
    pub parts: Vec<FolderPart>,
    pub crash: Vec<String>,
    #[serde(default)]
    pub cwd: Vec<String>,
    pub how: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderQuery {
    pub home: String,
    pub platform: String,
    pub env: BTreeMap<String, String>,
    pub tmps: Vec<String>,
}
