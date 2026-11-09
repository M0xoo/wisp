//! wisp-grid-client-api: the contract of `wisp.grid-client` (plan §7.2.2, ADR-0010, 0038, 0041): signing in
//! to a wisp Grid (RFC 8628), this computer as a peer others reach through the grid (`computer`), and
//! wisp Cloud as the place shares go (`share.destination@1`'s `wisp-cloud`): links, access, versions,
//! imports and their updates. The ids are the permissions (`grid-client.signin` → `grid-client:signin`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Command;

pub const PLUGIN: &str = "wisp.grid-client";
/// The grid wisp signs in to when none is named.
pub const DEFAULT_GRID: &str = "https://grid.trywisp.dev";
/// The setting "Show local pages in previews" (off: a `p<port>--` request through the tunnel is refused).
pub const PREVIEWS: &str = "grid-client.previews";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct SignInArgs {
    /// the grid's address (`https://grid.trywisp.dev`, `http://wisp.localhost:8080`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<String>,
    /// once signed in, turn this computer on too
    #[serde(default)]
    pub add_computer: bool,
}

/// A sign-in under way (or done): what to show while the browser approves it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct SignIn {
    pub id: String,
    pub grid: String,
    /// waiting | done | denied | expired | failed | cancelled
    pub state: String,
    pub user_code: String,
    pub verify_url: String,
    pub expires_at: i64,
    #[serde(default)]
    pub error: String,
    /// the handle signed in as, once done
    #[serde(default)]
    pub handle: String,
    /// the machines peer made for the cloud box, once done
    #[serde(default)]
    pub machine: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "grid-client/")]
pub struct IdArgs {
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "grid-client/")]
pub struct NoArgs {}

/// This computer on the grid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct ComputerState {
    pub on: bool,
    /// off | connecting | online | retrying | gone
    pub state: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub error: String,
    /// the next redial, ms from now (retrying)
    #[serde(default)]
    pub retry_in_ms: Option<u64>,
}

/// `grid-client.status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct Status {
    pub signed_in: bool,
    #[serde(default)]
    pub grid: String,
    #[serde(default)]
    pub handle: String,
    /// the cloud box's peer in machines
    #[serde(default)]
    pub machine: String,
    pub computer: ComputerState,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "grid-client/")]
pub struct ComputerArgs {
    pub on: bool,
    /// its name on the grid (this computer's host name by default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A change to one of my shares.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct AccessArgs {
    pub id: String,
    /// `{ kind: anyone|people|teams|password, people?, teams?, password? }`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub access: Option<Value>,
    /// ms since the epoch; 0 clears it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish: Option<bool>,
}

/// A link, an id, or `grid://<handle>/<name>[?ref=v2]`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct FetchArgs {
    pub link: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// A share as fetched: its card, which version, its content, and whether the signature holds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct Fetched {
    #[ts(type = "unknown")]
    pub card: Value,
    pub version: i64,
    pub latest: i64,
    /// the content, as JSON
    #[ts(type = "unknown")]
    pub content: Value,
    /// the signature is the signer's, over these exact bytes
    pub verified: bool,
    pub signer: String,
}

/// I took version `version` of this share in (an import, a module source).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct ImportedArgs {
    pub link: String,
    pub version: i64,
}

/// An import whose share moved on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct Update {
    pub id: String,
    pub url: String,
    pub title: String,
    pub kind: String,
    pub have: i64,
    pub latest: i64,
}

/// `wisp sandbox new [name]`: a box of its own on the grid, kept as a peer (ADR-0041).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "grid-client/")]
pub struct SandboxArgs {
    /// what it's for ("fix the login")
    #[serde(default)]
    pub name: String,
}

/// A sandbox on the grid, and the peer wisp keeps for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "grid-client/")]
pub struct Sandbox {
    pub id: String,
    pub name: String,
    pub url: String,
    /// its peer in machines ("" when there's none here)
    #[serde(default)]
    pub machine: String,
}

/// `wisp team …`: team spaces on the grid (ADR-0041).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "grid-client/")]
pub struct TeamsArgs {
    /// ls | new | show | add | rm
    pub op: String,
    #[serde(default)]
    pub slug: String,
    /// a new team's name
    #[serde(default)]
    pub name: String,
    /// the member to add or remove
    #[serde(default)]
    pub handle: String,
    /// owner | admin | member | viewer
    #[serde(default)]
    pub role: String,
}

macro_rules! command {
    ($name:ident = $id:literal $(read $ro:ident)? : $args:ty => $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
            fn args_ts() -> Option<String> {
                Some(<$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default()))
            }
        }
    };
}

command!(SignInCmd = "grid-client.signin" : SignInArgs => SignIn);
command!(SignInGet = "grid-client.signinStatus" read yes : IdArgs => SignIn);
command!(SignInCancel = "grid-client.signinCancel" : IdArgs => SignIn);
command!(StatusCmd = "grid-client.status" read yes : NoArgs => Status);
command!(SignOut = "grid-client.signout" : NoArgs => Status);
command!(Computer = "grid-client.computer" : ComputerArgs => ComputerState);
command!(Shares = "grid-client.shares" read yes : NoArgs => Value);
command!(Access = "grid-client.access" : AccessArgs => Value);
command!(Revoke = "grid-client.revoke" : IdArgs => Value);
command!(Fetch = "grid-client.fetch" read yes : FetchArgs => Fetched);
command!(Imported = "grid-client.imported" : ImportedArgs => Value);
command!(Updates = "grid-client.updates" read yes : NoArgs => Vec<Update>);
command!(SandboxNew = "grid-client.sandbox" : SandboxArgs => Sandbox);
command!(SandboxList = "grid-client.sandboxes" read yes : NoArgs => Vec<Sandbox>);
command!(SandboxRemove = "grid-client.sandboxRemove" : IdArgs => Value);
command!(Teams = "grid-client.teams" : TeamsArgs => Value);
