//! The sections of grid.json, as typed settings. Unknown keys are kept (`extra`) so `wisp grid init`
//! writes back what an operator added.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default)]
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// OIDC: the issuer; Google's is built in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    /// GitHub: where to send the browser and call the API (tests point them at a fake).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seats {
    pub min: i64,
    pub cap: i64,
    pub target: f64,
    pub every_hours: f64,
    pub hold_days: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Allow {
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub github_orgs: Vec<String>,
    #[serde(default)]
    pub accounts: Vec<String>,
}

/// `auth.maxUsers`: a number, or "auto" (seats that grow with the host).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaxUsers {
    Fixed(i64),
    Auto,
}

impl Serialize for MaxUsers {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Fixed(n) => s.serialize_i64(*n),
            Self::Auto => s.serialize_str("auto"),
        }
    }
}

impl<'de> Deserialize<'de> for MaxUsers {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        match &v {
            Value::String(s) if s == "auto" => Ok(Self::Auto),
            Value::Number(n) if n.as_i64().is_some_and(|n| n > 0) => {
                Ok(Self::Fixed(n.as_i64().unwrap_or(1)))
            }
            _ => Err(serde::de::Error::custom(
                "auth.maxUsers: a whole number above 0, \"auto\", or leave it out for no limit.",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub dev: bool,
    pub providers: BTreeMap<String, ProviderConfig>,
    pub signup: String,
    pub allow: Allow,
    pub admins: Vec<String>,
    pub seats: Seats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_users: Option<MaxUsers>,
}

/// The container driver's settings (the defaults are boxd's `CONTAINER`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_swap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpus: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pids: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns: Option<Vec<String>>,
    /// boxd's socket: with it, boxd runs the containers and the grid needs no Docker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boxd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `hostd.admit`: false, or the memory one more box needs and what the host keeps for itself.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdmitConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_mb: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve_mb: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostdConfig {
    /// "process" or "container".
    pub driver: String,
    pub idle_ms: i64,
    pub check_ms: i64,
    pub start_ms: i64,
    pub max_running: i64,
    pub env: BTreeMap<String, String>,
    pub path: String,
    /// `false` (as a JSON value) turns admission off; an object sets it; absent: the driver's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admit: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previews: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evict_after_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<ContainerConfig>,
    /// The box's entry: the Rust `wisp` binary by default; tests run a stand-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wisp_bin: Option<String>,
    /// hostd in its own process (`wisp-grid-hostd`): the unix socket the edge reaches it on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl HostdConfig {
    /// `hostd.admit`, read: None for off, Some for on (with the given numbers, defaults filled later).
    pub fn admit(&self) -> Option<Option<AdmitConfig>> {
        match &self.admit {
            None => None,
            Some(Value::Bool(false)) => Some(None),
            Some(v) => Some(serde_json::from_value(v.clone()).ok()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rows: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_retry_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_api: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailInbound {
    pub provider: String,
    #[serde(default)]
    pub topic_arn: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dkim_keys: Option<BTreeMap<String, String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailOutbound {
    pub provider: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub access_key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_access_key_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_access_key_env: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailConfig {
    pub domain: String,
    pub inbound: MailInbound,
    pub outbound: MailOutbound,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_per_hour: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_days: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sites`, `shares`, `sandboxes`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_user: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_bytes: Option<i64>,
}
