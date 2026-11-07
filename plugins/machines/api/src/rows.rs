//! Rows on the `machines` topic: a peer (what's stored) and its live status (what's shown). The
//! UI reads them, so their TypeScript comes from here (ts-rs).
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// `ssh`: OpenSSH with a `-L` forward · `grid`: a cloud computer or sandbox · `grid-tunnel`: another
/// of your computers, through the tunnel it holds to the grid. Any other string is a user's transport.
pub type TransportKind = String;

pub const SSH: &str = "ssh";
pub const GRID: &str = "grid";
pub const GRID_TUNNEL: &str = "grid-tunnel";

/// A peer, as stored (v1's `config.machines` entry with a `transport`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerRow {
    /// the local handle: v1's machine id (6 hex), or a new one
    pub id: String,
    /// the far side's `peer_id`, from its welcome; `None` until it has answered once (or a v1 wisp)
    #[serde(default)]
    pub peer: Option<String>,
    pub name: String,
    pub transport: TransportKind,
    /// ssh: the target (`user@host`, an alias from `~/.ssh/config`); grid: its host (`data.url` is the origin)
    pub address: String,
    /// ssh: wisp's port over there; grid: the origin's port
    pub port: u16,
    /// ssh: a custom start command, '' for this version's wisp binary
    #[serde(default)]
    pub command: String,
    #[serde(default = "yes")]
    pub auto_connect: bool,
    #[serde(default)]
    pub added_at: i64,
    /// the transport's own fields (grid: url, grid, handle, user, computer, sandbox, owner)
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub data: BTreeMap<String, Value>,
}

fn yes() -> bool {
    true
}

impl PeerRow {
    pub fn data_str(&self, k: &str) -> Option<&str> {
        self.data.get(k).and_then(Value::as_str)
    }
    /// v1's `kind`: 'grid' for both grid transports, else the transport.
    pub fn kind(&self) -> &str {
        if self.transport == GRID_TUNNEL {
            GRID
        } else {
            &self.transport
        }
    }
    /// another of your computers on a grid (v1 `computer`): only its owner turns it on
    pub fn computer(&self) -> Option<&str> {
        self.data_str("computer")
    }
    pub fn sandbox(&self) -> Option<&str> {
        self.data_str("sandbox")
    }
    pub fn is_grid(&self) -> bool {
        self.kind() == GRID
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PeerState {
    Off,
    Connecting,
    Reconnecting,
    Online,
    Asleep,
    Error,
    /// outside the protocol window (plan §7.3.2): the card says which side to update
    Incompatible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Pending,
    Run,
    Done,
    Warn,
    Fail,
}

impl StepStatus {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "run" => Self::Run,
            "done" => Self::Done,
            "warn" => Self::Warn,
            "fail" => Self::Fail,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Step {
    pub id: String,
    pub label: String,
    pub status: StepStatus,
    pub detail: String,
}

/// What a failure most likely needs, in words for someone who has never used SSH (v1 `sshHint`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// the page offers the "type your password once" box (`machines.letIn`)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub let_in: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tailscale: bool,
}

impl Hint {
    pub fn titled(title: &str, text: impl Into<String>) -> Self {
        Self {
            title: Some(title.to_owned()),
            text: text.into(),
            ..Self::default()
        }
    }
}

/// What the UI needs of a peer's harness list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgent {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub models: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub efforts: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub delegates: Option<Value>,
    /// only `false` is kept: an absent field means signed in or not applicable
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct RemoteInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<RemoteAgent>>,
    /// 1: a v1 wisp, reached through the whole-stream relay; 2+: the sync protocol
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proto: Option<u32>,
}

/// The live side of a peer, beside its row on the `machines` topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PeerStatus {
    pub id: String,
    pub state: PeerState,
    pub steps: Vec<Step>,
    pub error: String,
    pub hint: Option<Hint>,
    pub attempt: u32,
    pub since: Option<i64>,
    pub remote: Option<RemoteInfo>,
    /// an older wisp there refused this API: its pid, for Restart wisp there
    pub stale: Option<u32>,
    /// a request gets through though it isn't online: an asleep cloud computer wakes on one
    pub wakes: bool,
    /// which side must update, while `incompatible`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
}

impl PeerStatus {
    pub fn off(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            state: PeerState::Off,
            steps: Vec::new(),
            error: String::new(),
            hint: None,
            attempt: 0,
            since: None,
            remote: None,
            stale: None,
            wakes: false,
            update: None,
        }
    }
}

/// A peer as `GET /api/machines` shows it: v1's view (its names kept for older clients) plus v2's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub id: String,
    pub peer: Option<String>,
    pub name: String,
    pub transport: TransportKind,
    pub address: String,
    pub port: u16,
    pub command: String,
    pub auto_connect: bool,
    pub added_at: i64,
    /// v1: 'ssh' | 'grid'
    pub kind: String,
    /// v1: the address
    pub target: String,
    pub default_command: String,
    pub state: PeerState,
    pub steps: Vec<Step>,
    pub error: String,
    pub hint: Option<Hint>,
    /// v1: a bool (there is a stale pid)
    pub stale: bool,
    pub attempt: u32,
    pub since: Option<i64>,
    pub remote: Option<RemoteInfo>,
    /// the version Restart wisp there would bring it to, or `None`
    pub outdated: Option<String>,
    pub log: Vec<String>,
    /// projects with a checkout there
    pub projects: u32,
    /// its tasks running now (from the mirrored list)
    pub working: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
    /// the transport's own fields, flattened as v1 had them (url, grid, handle, computer, sandbox…)
    #[serde(flatten)]
    #[ts(skip)]
    pub data: BTreeMap<String, Value>,
}

/// A row the far side shows on its `list` topic, as this wisp mirrors it (ids as the peer made them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MirrorRow {
    /// the local handle of the peer
    pub peer: String,
    pub id: String,
    #[ts(type = "Record<string, unknown>")]
    pub v: Value,
}

/// A host found on this computer (`~/.ssh/config`, the tailnet, `known_hosts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct FoundHost {
    pub target: String,
    pub name: String,
    /// 'ssh-config' | 'tailscale' | 'known-hosts'
    pub source: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

/// A `Host` from `~/.ssh/config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SshHost {
    pub host: String,
    pub hostname: String,
    pub user: String,
}

/// Settings → Machines → This computer: can other devices reach it over SSH?
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Reachability {
    pub os: String,
    pub user: String,
    pub hostname: String,
    pub ssh: SshServer,
    pub tailscale: TailscaleSelf,
    pub keys: u32,
    /// how another device would connect: the tailnet name when there is one
    pub target: String,
    /// machines run wisp's bootstrap with `sh`: Windows needs WSL for that
    pub supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SshServer {
    pub running: bool,
    pub banner: String,
    pub port: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TailscaleSelf {
    pub installed: bool,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    /// Tailscale SSH is on; `None` when the prefs couldn't be read
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<bool>,
}
