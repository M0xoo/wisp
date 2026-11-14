//! Row types: what the page reads of accounts, sign-ins, keys, the harness watch and the harnesses'
//! disk. Field for field v1's JSON (camelCase), so v1 clients keep reading them.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub enum AccountKind {
    #[default]
    Personal,
    Work,
}

impl AccountKind {
    pub const ALL: [Self; 2] = [Self::Personal, Self::Work];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Work => "work",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub enum AccountState {
    Ready,
    Limit,
    SignedOut,
}

/// One account as the page sees it (no folders): v1 `Accounts.view()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub struct AccountView {
    pub id: String,
    pub label: String,
    pub email: String,
    pub plan: String,
    /// the CLI's own folder
    pub default: bool,
    pub kind: AccountKind,
    pub state: AccountState,
    /// when its usage limit ends (ms), while it is at one
    #[ts(type = "number | null")]
    pub until: Option<i64>,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct AccountsOut {
    pub accounts: Vec<AccountView>,
}

/// `POST /agents/:id/accounts`: the new account, the list, and its sign-in (started at once).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct AddOut {
    pub account: AccountView,
    pub accounts: Vec<AccountView>,
    pub login: LoginView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub enum LoginState {
    Idle,
    Running,
    Waiting,
    Done,
    Failed,
    Cancelled,
}

impl LoginState {
    /// still going: running or waiting for the user
    pub fn live(self) -> bool {
        matches!(self, Self::Running | Self::Waiting)
    }
}

/// A sign-in as the page sees it (v1 agent-login `view`). `account` is '' for the CLI's own. An idle
/// one carries only `agent`, `account` and `state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub struct LoginView {
    pub agent: String,
    pub account: String,
    pub state: LoginState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<String>,
    /// the CLI waits for a code pasted back
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub needs_input: Option<bool>,
    /// a code was pasted and the CLI hasn't answered yet: the page shows a spinner
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    /// its last few lines
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub started_at: Option<i64>,
}

impl LoginView {
    pub fn idle(agent: &str, account: &str) -> Self {
        Self {
            agent: agent.into(),
            account: account.into(),
            state: LoginState::Idle,
            url: None,
            code: None,
            needs_input: None,
            checking: None,
            error: None,
            output: None,
            started_at: None,
        }
    }
}

/// What the CLI says about a login (v1 agent-login `status`). `signedIn` null: an answer we don't know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub struct LoginStatus {
    pub agent: String,
    pub account: String,
    pub signed_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct KeyProviderView {
    pub id: String,
    pub name: String,
    pub set: bool,
}

/// A key sign-in's providers (opencode Zen and Go): which have a key, never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct KeysView {
    pub agent: String,
    pub url: String,
    /// the env var that signs every provider in, when wisp's environment has it; '' otherwise
    pub env: String,
    pub providers: Vec<KeyProviderView>,
}

// ---------- harness watch ----------

/// A harness's program as wisp saw it (v1 harness-watch `shown` + `mtimeMs`/`at`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub struct Fingerprint {
    /// as found (a PATH entry or the path itself)
    pub path: String,
    /// what it really is (links followed)
    pub real: String,
    #[ts(type = "number")]
    pub size: u64,
    pub sha256: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mtime_ms: Option<f64>,
    /// when it was pinned
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub enum ChangeKind {
    /// a newer version in the same install folder: an info line
    Update,
    /// anything else (another folder, other bytes at the same version): a warning
    Warn,
}

/// The open change of a harness's program since the pin (v1 `{ kind, from, to, at }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct WatchChange {
    pub kind: ChangeKind,
    pub from: Fingerprint,
    pub to: Fingerprint,
    #[ts(type = "number")]
    pub at: i64,
}

/// For the harness list: its pin date and open change (v1 `harnessWatch.view(id)`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub struct WatchView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub pinned_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub changed: Option<WatchChange>,
}

// ---------- the harnesses' own disk (This Mac → Free up space) ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct DiskPart {
    pub label: String,
    /// with `~` for the home folder
    pub path: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct DiskRemovable {
    pub count: u32,
    #[ts(type = "number")]
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct DiskHarness {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub bytes: u64,
    pub parts: Vec<DiskPart>,
    pub removable: DiskRemovable,
    /// the CLI's own way to keep less
    pub how: String,
}

/// The reclaim group for GET /machine (v1 HarnessDisk.view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "accounts/")]
pub struct DiskView {
    /// always 'harness'
    pub kind: String,
    pub count: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    pub ids: Vec<String>,
    #[ts(type = "number")]
    pub total: u64,
    #[ts(type = "number")]
    pub measured_at: i64,
    pub harnesses: Vec<DiskHarness>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct CleanOut {
    pub removed: u32,
    #[ts(type = "number")]
    pub freed: u64,
}

/// A note for the phone (v1 `bankedNote`: `{ title, text, actions }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct Note {
    pub title: String,
    pub text: String,
    #[ts(type = "Array<unknown>")]
    pub actions: Vec<Value>,
}
