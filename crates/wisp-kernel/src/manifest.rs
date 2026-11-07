//! `wisp-plugin.json` (plan §6.2): the whole static truth about a plugin, read without running it.
//! The same schema serves built-in crates, exec-tier plugins and users' declarative plugins (ex-spells).
//! The checks are in `manifest_check` (every problem with its path); this file is the typed view.
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
    /// the plugin's QA folder (plan §6.2 example). Added in v2.0 (additive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa: Option<String>,
}

/// One problem in a manifest, with the JSON path it is at (`contributes.settings[0].type`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

/// A requirement: a plugin id or a service contract id, with a range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub id: String,
    pub version: String,
    pub optional: bool,
}

/// A setting a plugin declares (`contributes.settings`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDecl {
    pub key: String,
    /// 'string' | 'int' | 'bool' | 'enum' | 'json'
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// another plugin may set (and lock) it through `contributes.setSettings`
    #[serde(default)]
    pub overridable: bool,
    /// 'server' (synced through the store) or 'device' (this client only)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl SettingDecl {
    /// Why `value` doesn't fit this declaration, or `None`.
    pub fn problem(&self, value: &Value) -> Option<String> {
        match self.ty.as_str() {
            "string" => (!value.is_string()).then(|| "must be a string".to_owned()),
            "bool" => (!value.is_boolean()).then(|| "must be true or false".to_owned()),
            "enum" => {
                let values = self.values.as_deref().unwrap_or_default();
                (!value
                    .as_str()
                    .is_some_and(|s| values.iter().any(|v| v == s)))
                .then(|| format!("must be one of {}", values.join(", ")))
            }
            "int" => {
                let Some(n) = value
                    .as_i64()
                    .map(|n| n as f64)
                    .or_else(|| value.as_u64().map(|n| n as f64))
                else {
                    return Some("must be a whole number".to_owned());
                };
                if let Some(lo) = self.min.filter(|lo| n < *lo) {
                    return Some(format!("must be at least {lo}"));
                }
                self.max
                    .filter(|hi| n > *hi)
                    .map(|hi| format!("must be at most {hi}"))
            }
            _ => None,
        }
    }
    pub fn device(&self) -> bool {
        self.scope.as_deref() == Some("device")
    }
}

/// A UI extension (`contributes.ui`): attached to a parent's input in the extension tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiExtension {
    pub id: String,
    pub attach_to: AttachTo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(default, rename = "if", skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachTo {
    pub id: String,
    pub input: String,
}

/// A command a manifest lists (`contributes.commands`): the palette shows it before any code loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDecl {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimistic: Option<String>,
}

impl Manifest {
    /// Parses a manifest embedded with `include_str!`. An invalid built-in manifest yields a manifest
    /// whose id is `invalid.manifest`; the kernel refuses it and every plugin crate's tests fail on it.
    pub fn embedded(json: &str) -> Self {
        Self::parse(json).unwrap_or_else(|e| Self {
            id: "invalid.manifest".into(),
            description: Some(e.message),
            ..Self::default()
        })
    }

    pub fn parse(json: &str) -> Result<Self> {
        let v: Value = serde_json::from_str(json)
            .map_err(|e| WireError::invalid(format!("wisp-plugin.json: {e}")))?;
        Self::from_value(v)
    }

    /// Checks then reads a manifest given as JSON. The error lists every problem with its path.
    pub fn from_value(v: Value) -> Result<Self> {
        let problems = Self::check(&v);
        if !problems.is_empty() {
            let id = v
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("wisp-plugin.json");
            let text = problems
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; ");
            let details = serde_json::to_value(&problems).unwrap_or(Value::Null);
            return Err(WireError::invalid(format!("{id}: {text}"))
                .with_details(serde_json::json!({ "errors": details })));
        }
        serde_json::from_value(v).map_err(|e| WireError::invalid(format!("wisp-plugin.json: {e}")))
    }

    /// Every problem in a manifest given as JSON; empty means valid.
    pub fn check(v: &Value) -> Vec<ManifestError> {
        crate::manifest_check::check(v)
    }

    /// Re-checks this manifest as a whole (the kernel does it for every plugin it is given).
    pub fn validate(&self) -> Result<()> {
        if self.id == "invalid.manifest" {
            return Err(WireError::invalid(
                self.description
                    .clone()
                    .unwrap_or_else(|| "invalid manifest".into()),
            ));
        }
        let v = serde_json::to_value(self).map_err(|e| WireError::internal(e.to_string()))?;
        Self::from_value(v).map(|_| ())
    }

    pub fn requirements(&self) -> Vec<Requirement> {
        self.requires
            .iter()
            .map(|(id, v)| match v {
                Value::Object(o) => Requirement {
                    id: id.clone(),
                    version: o
                        .get("version")
                        .and_then(Value::as_str)
                        .unwrap_or("*")
                        .to_owned(),
                    optional: o.get("optional").and_then(Value::as_bool).unwrap_or(false),
                },
                _ => Requirement {
                    id: id.clone(),
                    version: v.as_str().unwrap_or("*").to_owned(),
                    optional: false,
                },
            })
            .collect()
    }

    /// The version this manifest provides `contract` at.
    pub fn provided(&self, contract: &str) -> Option<&str> {
        self.provides.get(contract)?.get("version")?.as_str()
    }

    pub fn exec(&self) -> Option<Vec<String>> {
        let a = self.server.as_ref()?.get("exec")?.as_array()?;
        Some(
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect(),
        )
    }

    pub fn is_module(&self) -> bool {
        self.kind.as_deref() == Some("module")
    }

    fn list<T: serde::de::DeserializeOwned>(&self, key: &str) -> Vec<T> {
        self.contributes
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| serde_json::from_value(x.clone()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn settings(&self) -> Vec<SettingDecl> {
        self.list("settings")
    }

    pub fn commands(&self) -> Vec<CommandDecl> {
        self.list("commands")
    }

    /// UI extensions, with `attachTo: "parent:input"` read as {id, input}.
    pub fn ui(&self) -> Vec<UiExtension> {
        let Some(list) = self.contributes.get("ui").and_then(Value::as_array) else {
            return Vec::new();
        };
        list.iter()
            .filter_map(|x| {
                let mut x = x.clone();
                if let Some(s) = x.get("attachTo").and_then(Value::as_str).map(str::to_owned)
                    && let Some((id, input)) = s.rsplit_once(':')
                {
                    x["attachTo"] = serde_json::json!({ "id": id, "input": input });
                }
                serde_json::from_value(x).ok()
            })
            .collect()
    }

    /// `contributes.setSettings`: other plugins' settings this one sets and locks.
    pub fn set_settings(&self) -> BTreeMap<String, Value> {
        self.contributes
            .get("setSettings")
            .and_then(Value::as_object)
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }

    /// Static contributions to a point (`runtime.harness`), live before any code loads.
    pub fn contributions(&self, point: &str) -> Vec<Value> {
        self.contributes
            .get(point)
            .map(|v| v.as_array().cloned().unwrap_or_else(|| vec![v.clone()]))
            .unwrap_or_default()
    }

    /// No `activation` list (or `onStartup` in it) starts at startup: an interceptor that never loaded
    /// would be a guard nobody runs, so lazy is something a manifest asks for.
    pub fn eager(&self) -> bool {
        self.activation.is_empty() || self.activation.iter().any(|a| a == "onStartup")
    }
}
