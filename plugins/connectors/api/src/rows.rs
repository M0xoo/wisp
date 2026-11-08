//! The rows wisp.connectors keeps and the shapes the page reads. Field names are v1's on the wire
//! (camelCase), so v1's Settings → Connectors and older phones keep reading them. Secret values never
//! appear here except in [`ProxySpec`], the one answer only the proxy may ask for.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// a command wisp starts, speaking MCP on its stdio
    #[default]
    Local,
    /// an MCP server at a URL (Streamable HTTP, or the 2024 SSE transport)
    Remote,
}

/// The outcome of starting it once and listing its tools (Settings shows it on the row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    #[ts(type = "number")]
    pub at: i64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    /// refused for want of a sign-in: the row offers Sign in
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub auth: bool,
}

/// Where a remote connector signs in (OAuth metadata, no secrets: the tokens are in the secrets file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthMeta {
    pub issuer: String,
    pub authorize: String,
    pub token: String,
    /// RFC 7591 registration endpoint; null: the server lets no app register itself
    pub register: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_id: Option<String>,
    /// the callback this client was registered for (registered once per place the browser returns to)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub redirect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    pub signed_in_at: Option<i64>,
}

/// A connector as wisp keeps it: what it is. `env` and `headers` are key names; their values are
/// secrets (`connector:<id>` → `env:<KEY>`, `header:<KEY>`, `oauth:access|refresh|secret`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub transport: Transport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub headers: Vec<String>,
    pub enabled: bool,
    #[ts(type = "number")]
    pub added_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub test: Option<ProbeResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub oauth: Option<OAuthMeta>,
}

/// A key name and whether it has a value (never the value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct KeyState {
    pub key: String,
    pub set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SignedIn {
    /// the authorization server's host
    pub host: String,
    #[ts(type = "number | null")]
    pub at: Option<i64>,
}

/// What the page sees of one: never a secret's value, only which keys are set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorView {
    pub id: String,
    pub name: String,
    pub transport: Transport,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env: Vec<KeyState>,
    pub headers: Vec<KeyState>,
    pub enabled: bool,
    pub test: Option<ProbeResult>,
    pub signed_in: Option<SignedIn>,
    #[ts(type = "number")]
    pub added_at: i64,
    /// harnesses that keep their own server by this name (it is skipped for them)
    pub own: Vec<String>,
    /// a test is running: the row shows Checking…
    pub testing: bool,
}

/// A server in a harness's own config that isn't a connector yet (key names only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct FoundServer {
    pub name: String,
    /// the harnesses' labels whose configs have it ("Claude Code", "Codex")
    pub from: Vec<String>,
    pub transport: Transport,
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
    pub env: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub headers: Option<Vec<String>>,
}

/// `GET /api/connectors`, and the answer of every command that changes one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct ConnectorsView {
    pub connectors: Vec<ConnectorView>,
    pub found: Vec<FoundServer>,
    /// harnesses that take connectors per turn
    pub reach: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Skipped {
    pub name: String,
    pub error: String,
}

/// `POST /api/connectors/import`: the view, plus the names that couldn't be imported and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct ImportView {
    #[serde(flatten)]
    pub view: ConnectorsView,
    pub skipped: Vec<Skipped>,
}

/// One `mcpServers` entry a turn gets: the proxy, started by connector id. No secret in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
pub struct McpServer {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// name → entry, as harnesses take `mcpServers`. Each harness plugin renders it in its own format.
pub type McpServers = BTreeMap<String, McpServer>;

/// What the proxy needs to run one connector: the only answer that carries secret values.
/// Never derived for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProxySpec {
    pub connector: Connector,
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    /// a signed-in connector's access token, when it has one
    pub access: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    /// a box per missing key
    Keys,
    /// an OAuth Sign in button
    Signin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum KeyField {
    Env,
    Headers,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AskKey {
    pub key: String,
    pub field: KeyField,
    pub set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AskConnector {
    pub id: String,
    pub name: String,
    pub kind: AskKind,
    pub keys: Vec<AskKey>,
}

/// The card `wisp_connector_signin` opens in the task (as `ask_user`'s); a `Works` event answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SigninAsk {
    pub question: String,
    pub context: String,
    pub options: Vec<String>,
    pub connector: AskConnector,
}

/// An agent tool's answer, as v1's `/internal/connectors` routes gave it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AgentText {
    pub text: String,
}

/// `wisp_connector_signin`: a text when there is nothing to ask, else the card to open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum AgentSigninOut {
    Text { text: String },
    Ask { ask: SigninAsk },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SigninUrl {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SignedInName {
    pub name: String,
}

/// The proxy's fresh OAuth token; null: sign in again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenOut {
    pub token: Option<String>,
}
