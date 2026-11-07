//! `wisp-plugin.json` (plan §6.2): the whole static truth about a plugin, read without running it.
//! The same schema serves built-in crates, exec-tier plugins and users' declarative plugins (ex-spells).
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Result, WireError};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub wisp_plugin: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub version: String,
    pub api: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// 'plugin' (owns a domain) or 'module' (extends exactly one plugin)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    /// plugin ids or service contract ids → semver range, or {version, optional}
    #[serde(default)]
    pub requires: BTreeMap<String, Value>,
    #[serde(default)]
    pub provides: BTreeMap<String, Value>,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// {"builtin": "<crate>"} or {"exec": ["bin", "args"]}
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<Value>,
    #[serde(default)]
    pub activation: Vec<String>,
    #[serde(default)]
    pub disable: Vec<String>,
    #[serde(default)]
    pub contributes: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrations: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
}

impl Manifest {
    /// Parses a manifest embedded with `include_str!`. An invalid built-in manifest yields a manifest
    /// whose id is `invalid.manifest`; the kernel refuses it and every plugin crate's tests fail on it.
    pub fn embedded(json: &str) -> Self {
        Self::parse(json).unwrap_or_else(|e| Self { id: "invalid.manifest".into(), description: Some(e.message), ..Self::default() })
    }

    pub fn parse(json: &str) -> Result<Self> {
        let m: Self = serde_json::from_str(json).map_err(|e| WireError::invalid(format!("wisp-plugin.json: {e}")))?;
        m.validate()?;
        Ok(m)
    }

    pub fn validate(&self) -> Result<()> {
        if self.wisp_plugin != 1 {
            return Err(WireError::invalid(format!("{}: wispPlugin must be 1", self.id)));
        }
        if !self.id.contains('.') {
            return Err(WireError::invalid(format!("{}: id must be owner-prefixed (wisp.x, acme.y)", self.id)));
        }
        Ok(())
    }
}
