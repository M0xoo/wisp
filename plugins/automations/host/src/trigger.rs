//! wisp.automations' `trigger` kind (ADR-0028): what starts tasks without you: CI failed, an issue
//! labelled, a task finished or done, a webhook, a Slack or Linear message, each starting a declared task
//! (or a prompt). Kept as declared (`StoredKind`) until the watchers are ported; sensitive.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// A trigger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerSpec {
    /// ci | issues | finished | done | webhook | slack | linear
    pub on: String,
    /// the declared task it starts (its `{params}` from the event)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub task: String,
    /// or a prompt of its own
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prompt: String,
    /// the project it watches
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project: String,
    /// a crew member gets the work instead of a new task
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crew: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    /// the issue label it waits for
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// minutes between GitHub polls
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<u32>,
    /// a webhook's signature secret, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<TriggerSpec>(s, |sc| KindInfo::new("trigger", "triggers", "wisp.automations", sc).order(85).sensitive());
}
