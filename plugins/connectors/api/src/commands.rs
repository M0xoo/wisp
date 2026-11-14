//! Commands (an action: its id is its permission, `connectors.add` → `connectors:add`) and events (a
//! fact, published after the command commits). v1's routes are thin adapters over these.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::{Command, Event};

use crate::rows::{
    AgentSigninOut, AgentText, ConnectorsView, ImportView, McpServers, ProxySpec, SignedInName, SigninUrl, TokenOut, Transport,
};

// ---------- argument shapes ----------

/// One secret field as the page sends it in a list: `{key, value}`; no value keeps a saved one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct SecretField {
    pub key: String,
    #[serde(default)]
    pub value: Value,
}

/// Env vars or headers in a body, as v1 took them: `{KEY: "value"}` or `[{key, value}]`. A value that
/// is `""`, null or the mask (`••••`, what the page shows for a saved one) keeps the saved value; a key
/// left out is dropped with its value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum SecretInput {
    List(Vec<SecretField>),
    Map(BTreeMap<String, Value>),
}

/// A connector as a body (`POST /connectors`, `PATCH /connectors/:id`). A field left out keeps what
/// the connector had; `command` alone is a whole command line, `command` + `args` is already split.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
pub struct ConnectorBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// `local` or `remote`; left out: remote when there is a URL
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub env: Option<SecretInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub headers: Option<SecretInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
}

impl ConnectorBody {
    /// Anything but the switch: the last test then says nothing about it (v1 routes PATCH).
    pub fn edits(&self) -> bool {
        self.name.is_some()
            || self.transport.is_some()
            || self.command.is_some()
            || self.args.is_some()
            || self.url.is_some()
            || self.env.is_some()
            || self.headers.is_some()
    }
}

/// `{}`: a command that takes nothing (unknown fields are ignored, as v1 did).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct NoArgs {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct IdArgs {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct UpdateArgs {
    pub id: String,
    #[serde(flatten)]
    pub body: ConnectorBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct ImportArgs {
    /// found servers to import, by name; their values are read on the server, never sent by the page
    #[serde(default)]
    pub names: Vec<String>,
    /// names to hide from the found list
    #[serde(default)]
    pub dismiss: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SigninArgs {
    pub id: String,
    /// the page's own origin: the browser comes back to `<origin>/api/connectors/oauth/callback`
    #[serde(default)]
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct OauthFinishArgs {
    /// the callback's query: `state`, `code`, or `error` and `error_description`
    #[serde(default)]
    pub query: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenArgs {
    pub id: String,
    /// the server refused the one it had: refresh even if it hasn't run out
    #[serde(default)]
    pub force: bool,
}

/// Which turn asks: the harness, its mode (`plan` gets none) and its folder (its own `.mcp.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct TurnQuery {
    pub agent: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
}

/// The agent tools speak for one session: the caller's own, or `sid` from v1's URL when the caller is
/// the user or the kernel. An agent naming another session is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentArgs {
    /// wisp.mcp sends it as `session`
    #[serde(default, alias = "session", skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
}

/// `wisp_connector_add`: key names only (`env: ["API_KEY"]`); a value would sit in the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AgentAddArgs {
    /// wisp.mcp sends it as `session`
    #[serde(default, alias = "session", skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    /// checked by the command: anything but an array of names is refused with the reason
    #[serde(default)]
    pub env: Option<Value>,
    #[serde(default)]
    pub headers: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentSigninArgs {
    /// wisp.mcp sends it as `session`
    #[serde(default, alias = "session", skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default)]
    pub name: String,
    /// shown on the card (≤ 400 chars)
    #[serde(default)]
    pub why: String,
}

// ---------- commands ----------

macro_rules! command {
    ($(#[$doc:meta])* $name:ident, $id:literal, $perm:literal, $read:literal, $args:ty, $out:ty) => {
        $(#[$doc])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            const READ_ONLY: bool = $read;
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(
    /// Settings → Connectors: every connector, the servers found in the harnesses' configs, the reach.
    List,
    "connectors.list",
    "connectors:list",
    true,
    NoArgs,
    ConnectorsView
);
command!(
    /// Adds one; its secrets go to the secrets file, and it is tested in the background.
    Add,
    "connectors.add",
    "connectors:add",
    false,
    ConnectorBody,
    ConnectorsView
);
command!(Update, "connectors.update", "connectors:update", false, UpdateArgs, ConnectorsView);
command!(Remove, "connectors.remove", "connectors:remove", false, IdArgs, ConnectorsView);
command!(
    /// Starts it through the proxy, the way an agent would, and keeps the outcome on the row.
    Test,
    "connectors.test",
    "connectors:test",
    false,
    IdArgs,
    ConnectorsView
);
command!(Import, "connectors.import", "connectors:import", false, ImportArgs, ImportView);
command!(
    /// OAuth sign-in (discovery, dynamic registration, PKCE): the URL the page opens.
    Signin,
    "connectors.signin",
    "connectors:signin",
    false,
    SigninArgs,
    SigninUrl
);
command!(Signout, "connectors.signout", "connectors:signout", false, IdArgs, ConnectorsView);
command!(
    /// The browser came back from the sign-in page: trade the code for tokens.
    OauthFinish,
    "connectors.oauthFinish",
    "connectors:oauthFinish",
    false,
    OauthFinishArgs,
    SignedInName
);
command!(
    /// The proxy's fresh token: wisp is the only writer of tokens, so the proxy never refreshes itself.
    Token,
    "connectors.token",
    "connectors:token",
    false,
    TokenArgs,
    TokenOut
);
command!(
    /// What the proxy runs for one connector, with its secret values: the proxy's token only.
    Spec,
    "connectors.spec",
    "connectors:spec",
    true,
    IdArgs,
    ProxySpec
);
command!(
    /// The `mcpServers` a turn gets (also [`crate::ConnectorsService`], for the runner's hot path).
    ForTurn,
    "connectors.forTurn",
    "connectors:forTurn",
    true,
    TurnQuery,
    McpServers
);
command!(
    /// `wisp_connectors`
    AgentList,
    "connectors.agent.list",
    "connectors:agent.list",
    true,
    AgentArgs,
    AgentText
);
command!(
    /// `wisp_connector_add`: only a task the user started (not a subagent, not a crew member's job)
    AgentAdd,
    "connectors.agent.add",
    "connectors:agent.add",
    false,
    AgentAddArgs,
    AgentText
);
command!(
    /// `wisp_connector_signin`: the card where the user signs in or types the keys
    AgentSignin,
    "connectors.agent.signin",
    "connectors:agent.signin",
    true,
    AgentSigninArgs,
    AgentSigninOut
);

/// `connectors.call`: one tool of a remote (HTTP) connector, called by wisp itself with the connector's own
/// sign-in or headers (v1 connectors.js `mcpCall`; the issue picker lists Linear and Jira through them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "connectors/")]
pub struct CallArgs {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub args: Value,
}

/// The tool's result as the server gave it (`content`, `structuredContent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "connectors/")]
pub struct CallOut {
    #[ts(type = "unknown")]
    pub result: Value,
}

command!(
    /// A remote connector's tool, called by wisp (not an agent): its sign-in stays here.
    Call,
    "connectors.call",
    "connectors:call",
    false,
    CallArgs,
    CallOut
);

// ---------- events ----------

/// Settings should look again (v1 `broadcast('connectors')`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct Changed {}

impl Event for Changed {
    const TYPE: &'static str = "connectors.changed";
}

/// It works now: a task waiting on its sign-in or keys (`wisp_connector_signin`) carries on with `text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Works {
    pub id: String,
    pub name: String,
    pub count: u32,
    pub text: String,
}

impl Event for Works {
    const TYPE: &'static str = "connectors.works";
}

/// An agent added one (counts only, for telemetry: v1 `connector_tool`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AgentAdded {
    pub agent: String,
    pub transport: Transport,
}

impl Event for AgentAdded {
    const TYPE: &'static str = "connectors.agent_added";
}
