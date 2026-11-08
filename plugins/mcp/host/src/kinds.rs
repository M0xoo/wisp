//! wisp.mcp's resource kind (ADR-0028): which of wisp's own MCP tools agents get, per agent profile or
//! mode (`tools:` in a formula, named by the profile or mode).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// wisp's tools for one agent profile or mode (its name): what it gets and what it doesn't.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolsSpec {
    /// tool names (`wisp_ask`, `wisp_delegate`, `wisp_*`); empty: every one
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// tool names it never gets
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<ToolsSpec>(s, |sc| KindInfo::new("tools", "tools", "wisp.mcp", sc).order(22));
}
