//! wisp.connectors' resource kind (ADR-0028): MCP servers agents get. Kept as declared (`StoredKind`)
//! until the host ports v1's connectors; env values are `${secret:NAME}` references.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// An MCP server: a command wisp starts, or a URL it reaches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorSpec {
    /// the program (stdio servers)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// the server's URL (HTTP servers)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// its environment; secrets as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// HTTP headers; secrets as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// the agent profiles that get it (empty: every one)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    /// the modes that get it (plan, edits, auto; empty: all)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<String>,
    /// off: declared but no agent gets it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// it signs in with OAuth (the token stays in secrets)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<bool>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<ConnectorSpec>(s, |sc| KindInfo::new("connector", "connectors", "wisp.connectors", sc).order(18));
}
