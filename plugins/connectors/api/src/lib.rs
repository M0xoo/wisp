//! wisp-connectors-api: the contract of wisp.connectors, the user's MCP servers (added once in
//! Settings → Connectors) handed to every task's agent whatever the harness. The port of v1's
//! server/connectors.js, connector-auth.js, mcp-connector.js and routes/connectors.js.
//!
//! Secret values (env vars, headers, OAuth tokens) never leave wisp.connectors except to the proxy a
//! harness starts for one connector ([`Spec`]): the page and the agent see key names only.

pub mod commands;
pub mod rows;
pub mod service;

pub use commands::*;
pub use rows::*;
pub use service::*;

pub const PLUGIN_ID: &str = "wisp.connectors";

/// The topic Settings → Connectors watches (v1 broadcast `connectors`).
pub const TOPIC: &str = "plugin:wisp.connectors:list";

/// Harnesses that take a server per turn in v1; cursor and antigravity only read their own config.
/// The live list comes from [`HARNESS_MCP`] contributions (`per_turn`).
pub const REACH: [&str; 5] = ["claude", "codex", "copilot", "opencode", "grok"];

/// What the page shows for a saved secret; sent back unchanged, it keeps the saved value.
pub const MASK: &str = "••••••••";

/// The callback the sign-in page sends the browser back to, under the page's own origin.
pub const OAUTH_CALLBACK: &str = "/api/connectors/oauth/callback";

/// The secrets namespace of one connector (v1 `connector:<id>`, so v1's secrets.json reads as it is).
pub fn secrets_ns(id: &str) -> String {
    format!("connector:{id}")
}
