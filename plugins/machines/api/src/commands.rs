//! Commands of `wisp.machines`. The id is the permission (`machines.add` → `machines:add`). v1's
//! `/api/machines/*` routes are thin adapters over these, same paths and JSON shapes.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Command;

use crate::rows::{FoundHost, MirrorRow, PeerView, Reachability, SshHost};

/// Input to `machines.add` and `machines.update`. v1 called the address `target` (accepted too).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AddArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// a number, or v1's string form ("4477"): validated by the transport
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | string")]
    pub port: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
    /// false: add it without connecting (v1 `connect: false`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(type = "Record<string, unknown>")]
    pub data: BTreeMap<String, Value>,
    /// a secret the transport keeps for it (a grid device token): to secrets, never to the row
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl AddArgs {
    /// `address`, else v1's `target`
    pub fn address(&self) -> Option<&str> {
        self.address.as_deref().or(self.target.as_deref())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct UpdateArgs {
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub set: AddArgs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct IdArgs {
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct NoArgs {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Done {
    pub ok: bool,
}

impl Done {
    pub const YES: Self = Self { ok: true };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RemoveOut {
    pub ok: bool,
    /// peers that went with it (an account's computers and sandboxes)
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StopArgs {
    pub id: String,
    #[serde(default)]
    pub restart: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LetInArgs {
    pub id: String,
    /// never stored, never logged, never in an argv: ssh reads it through SSH_ASKPASS
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LetInOut {
    pub ok: bool,
    pub made_key: bool,
    pub machine: Option<PeerView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RecheckArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SessionsArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// A JSON call passed through to a peer's API (v1's `machines.json`): path under `/api`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallArgs {
    pub id: String,
    pub method: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub body: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// A v2 command for a row another peer owns: sent there with the **same** idempotency key, so a
/// flaky tunnel never runs a follow-up twice, even across wakes (plan §7.2.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RouteArgs {
    /// the local handle; omitted: the peer named by the origin of `args.id`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub cmd: String,
    #[ts(type = "unknown")]
    pub args: Value,
    /// the idempotency key the client sent here
    pub mid: String,
}

macro_rules! command {
    ($(#[$m:meta])* $name:ident, $id:literal, $args:ty, $out:ty $(, read_only = $ro:literal)?) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = $ro;)?
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(Add, "machines.add", AddArgs, PeerView);
command!(Update, "machines.update", UpdateArgs, PeerView);
command!(
    /// its secrets, its mirrored rows and the peers that go with it (transport `forget`) go too
    Remove,
    "machines.remove",
    IdArgs,
    RemoveOut
);
command!(Connect, "machines.connect", IdArgs, PeerView);
command!(Disconnect, "machines.disconnect", IdArgs, PeerView);
command!(
    /// stop wisp over there (its agents too); `restart` starts this version in its place
    Stop,
    "machines.stop",
    StopArgs,
    PeerView
);
command!(LetIn, "machines.letIn", LetInArgs, LetInOut);
command!(
    /// watch without waking: an asleep box
    Follow,
    "machines.follow",
    IdArgs,
    Done
);
command!(RecheckAgents, "machines.recheckAgents", RecheckArgs, Done);
command!(
    List,
    "machines.list",
    NoArgs,
    Vec<PeerView>,
    read_only = true
);
command!(Get, "machines.get", IdArgs, PeerView, read_only = true);
command!(
    Sessions,
    "machines.sessions",
    SessionsArgs,
    Vec<MirrorRow>,
    read_only = true
);
command!(
    Hosts,
    "machines.hosts",
    NoArgs,
    Vec<SshHost>,
    read_only = true
);
command!(
    Discover,
    "machines.discover",
    NoArgs,
    Vec<FoundHost>,
    read_only = true
);
command!(
    Reachable,
    "machines.reachable",
    NoArgs,
    Reachability,
    read_only = true
);
command!(CallPeer, "machines.call", CallArgs, Value);
command!(Route, "machines.route", RouteArgs, Value);
