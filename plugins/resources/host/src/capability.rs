//! The `capability` kind (ADR-0028: "capability: kernel"): user-defined capability sets and API keys'
//! scopes. The kernel knows no kind, so wisp.resources holds it, kept as declared (`StoredKind`); it
//! changes who may act, so it is sensitive.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// A capability set: what its holder may do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilitySpec {
    /// permissions it grants (`runtime:create`, `crew:*`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// permissions it never grants, over `allow`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    /// an API key that holds it, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// the channels whose messages act with it
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<String>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<CapabilitySpec>(s, |sc| KindInfo::new("capability", "capabilities", "wisp.resources", sc).order(4).sensitive());
}
