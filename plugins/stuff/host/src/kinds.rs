//! wisp.stuff's resource kinds (ADR-0028): My Stuff's apps and panes with their source, data schema and
//! grants. Kept as declared (`StoredKind`); what an app keeps (its data) stays data.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// An app or a pane: where its code comes from and what it may do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSpec {
    /// a folder, or `starter:<name>` for one wisp ships
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// its code inline (a single-file app)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub inline: String,
    /// its data's shape (JSON Schema)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// what it may call (commands, topics)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<String>,
    /// off: kept but not shown
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<AppSpec>(s, |sc| KindInfo::new("app", "apps", "wisp.stuff", sc).order(70));
    let _ = stored::<AppSpec>(s, |sc| KindInfo::new("pane", "panes", "wisp.stuff", sc).order(71));
}
