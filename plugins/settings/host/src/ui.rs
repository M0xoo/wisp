//! The `ui` kind (ADR-0028): this device's look (theme, view, transcript, editor, keybindings, layout).
//! Device-scoped: never exported or applied from someone else's formula unless asked (`--include ui`).
//! Kept as declared (`StoredKind`); the frontends read it.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, Scope, stored};

/// How wisp looks on this device.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiSpec {
    /// light | dark | system
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub theme: String,
    /// list | board
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub view: String,
    /// compact | full
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub transcript: String,
    /// show read times on answers
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_times: Option<bool>,
    /// the editor files open in (`code`, `cursor`, `zed`)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub editor: String,
    /// the terminal app
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub terminal: String,
    /// key → action
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub keys: BTreeMap<String, String>,
    /// panel sizes and what's open
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Value>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<UiSpec>(s, |sc| KindInfo::new("ui", "ui", "wisp.settings", sc).singleton().scope(Scope::Device).order(6));
}
