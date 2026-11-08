//! wisp.channels' resource kinds (ADR-0028): channels (Telegram, Slack, Discord, GitHub, email, ntfy)
//! and notifications (what notifies where). Kept as declared (`StoredKind`); tokens are
//! `${secret:NAME}` references. A channel changes who may start work, so it is sensitive.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// A channel: where people talk to wisp and hear back from it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelSpec {
    /// telegram | slack | discord | github | email | ntfy
    pub transport: String,
    /// off by default: nothing is received or sent until it's on
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// its bot token or key, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    /// who may speak to it (chat ids, user names, addresses)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// the most a message may start: plan | edits (never auto)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cap: String,
    /// where its tasks run (a project or machine), and thread rules
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<Value>,
}

/// What notifies where: events to a channel or a webhook (v1 `notify`, `drainWatch`, `webhookTriggers`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NotificationSpec {
    /// events: `finished`, `asks`, `failed`, `limit`, `drain`, a trigger's name
    pub on: Vec<String>,
    /// a channel's name, or a webhook URL
    pub to: String,
    /// only for these projects (empty: every one)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<ChannelSpec>(s, |sc| KindInfo::new("channel", "channels", "wisp.channels", sc).order(40).sensitive());
    let _ = stored::<NotificationSpec>(s, |sc| KindInfo::new("notification", "notifications", "wisp.channels", sc).order(45));
}
