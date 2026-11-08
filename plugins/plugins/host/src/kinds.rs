//! wisp.plugins' resource kind (ADR-0028): which plugins are on, their config, and users' plugins (a path,
//! gist or URL, a version pin). Kept as declared (`StoredKind`) until the plugin manager is ported.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// A plugin by its id (`wisp.telegram`, `user.mine`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginSpec {
    /// on or off
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// where a user's plugin comes from: a path, `gist:<id>` or a URL
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// the version it stays on
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    /// its own configuration
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<PluginSpec>(s, |sc| KindInfo::new("plugin", "plugins", "wisp.plugins", sc).order(2).sensitive());
}
