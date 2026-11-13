//! wisp-plugins-api: the contract of `wisp.plugins`, the plugin manager: which plugins this wisp has and
//! switching them on and off (the kernel does it; ADR-0028's `plugin` kind declares it). v1's spells
//! are gone (ADR-0031): a plugin is a folder with a `wisp-plugin.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Command;

pub const PLUGIN_ID: &str = "wisp.plugins";

pub mod perm {
    pub const READ: &str = "plugins:read";
    pub const WRITE: &str = "plugins:write";
}

/// A plugin as the kernel has it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginRow {
    pub id: String,
    pub version: String,
    /// active | resolved | off | refused
    pub state: String,
    pub enabled: bool,
    pub builtin: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetEnabledArgs {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug)]
pub struct List;
impl Command for List {
    const ID: &'static str = "plugins.list";
    const PERMISSION: Option<&'static str> = Some(perm::READ);
    const READ_ONLY: bool = true;
    type Args = Value;
    type Out = Vec<PluginRow>;
}

#[derive(Debug)]
pub struct SetEnabled;
impl Command for SetEnabled {
    const ID: &'static str = "plugins.setEnabled";
    const PERMISSION: Option<&'static str> = Some(perm::WRITE);
    type Args = SetEnabledArgs;
    type Out = PluginRow;
}

// ---- what an agent writing an untrusted plugin reads and runs (ADR-0048; v1's spell tools, ADR-0031) ----

/// An agent tool's answer: `{ text }`, or `{ error }` for a refusal the agent reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentText {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AgentText {
    pub fn text(t: impl Into<String>) -> Self {
        Self { text: Some(t.into()), error: None }
    }
    pub fn error(e: impl Into<String>) -> Self {
        Self { text: None, error: Some(e.into()) }
    }
}

/// `wisp_plugins`, `wisp_plugin_schema`: nothing but the caller's task (set by wisp.mcp; none from `wisp mcp`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// `wisp_plugin_data`: a read-only command a plugin would call, and its arguments.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentDataArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// the command's id (`plugins.list`)
    #[serde(default)]
    pub command: String,
    /// its arguments (`{}` when left out)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

/// `wisp_plugin_check`: a plugin as files, never installed and never run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentCheckArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// its whole `wisp-plugin.json`
    #[serde(default)]
    pub manifest: Value,
    /// its other files' text by path in its folder (`{ "ui.js": "…" }`)
    #[serde(default)]
    pub files: std::collections::BTreeMap<String, String>,
}

/// `plugins.agent.list` (`wisp_plugins`): the plugins the user has, in plain words; theirs with their manifests.
#[derive(Debug)]
pub struct AgentList;
impl Command for AgentList {
    const ID: &'static str = "plugins.agent.list";
    const PERMISSION: Option<&'static str> = Some("plugins:agent.list");
    const READ_ONLY: bool = true;
    type Args = AgentArgs;
    type Out = AgentText;
}

/// `plugins.agent.schema` (`wisp_plugin_schema`): the reference for writing an untrusted plugin, from the real types.
#[derive(Debug)]
pub struct AgentSchema;
impl Command for AgentSchema {
    const ID: &'static str = "plugins.agent.schema";
    const PERMISSION: Option<&'static str> = Some("plugins:agent.schema");
    const READ_ONLY: bool = true;
    type Args = AgentArgs;
    type Out = AgentText;
}

/// `plugins.agent.data` (`wisp_plugin_data`): a sample of what a read-only command answers, run as the caller.
#[derive(Debug)]
pub struct AgentData;
impl Command for AgentData {
    const ID: &'static str = "plugins.agent.data";
    const PERMISSION: Option<&'static str> = Some("plugins:agent.data");
    const READ_ONLY: bool = true;
    type Args = AgentDataArgs;
    type Out = AgentText;
}

/// `plugins.agent.check` (`wisp_plugin_check`): a plugin validated without installing it.
#[derive(Debug)]
pub struct AgentCheck;
impl Command for AgentCheck {
    const ID: &'static str = "plugins.agent.check";
    const PERMISSION: Option<&'static str> = Some("plugins:agent.check");
    const READ_ONLY: bool = true;
    type Args = AgentCheckArgs;
    type Out = AgentText;
}
