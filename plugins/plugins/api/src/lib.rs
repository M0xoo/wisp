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
