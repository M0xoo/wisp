//! The rows wisp.automations shows: triggers (as the API and the UI see them, never with their secret or
//! bookkeeping) and recipes. JSON shapes are v1's (server/triggers.js triggerView, server/recipes.js), so
//! v1 clients keep working.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Where a task came from (v1 `session.origin`), kept in the task's ext slot `wisp.automations`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct Origin {
    /// `trigger` or `recipe`
    pub kind: String,
    pub id: String,
    pub name: String,
}

/// A trigger held back by "Automations stop at" (budget): the row says it skipped, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct Held {
    #[ts(type = "number")]
    pub at: i64,
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub until: Option<i64>,
    pub agent: String,
    /// the machine is short (memory, CPU), not the plan
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub load: bool,
}

/// One call at a hook's URL; the newest five are kept on the trigger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct Delivery {
    #[ts(type = "number")]
    pub at: i64,
    /// `started`, `skipped` or `rejected`
    pub result: String,
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<String>,
}

/// A trigger's fields as stored and shown (everything but its secret and bookkeeping).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct TriggerBase {
    pub id: String,
    pub name: String,
    /// schedule | ci | issues | finished | done | webhook | slack | linear
    pub kind: String,
    pub enabled: bool,
    pub cwd: String,
    /// a crew member's id: the work goes to them instead of a new task
    pub crew: String,
    pub prompt: String,
    pub recipe_id: String,
    #[ts(type = "Record<string, unknown>")]
    pub params: BTreeMap<String, Value>,
    pub agent: String,
    pub model: String,
    pub effort: String,
    /// plan | edits | auto
    pub mode: String,
    pub cron: String,
    pub branch: String,
    pub label: String,
    /// minutes between GitHub polls
    pub every: u32,
    #[serde(default)]
    pub seeded: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub last_run_at: Option<i64>,
    pub last_session_id: Option<String>,
    #[ts(type = "number | null")]
    pub last_polled_at: Option<i64>,
    pub last_error: String,
    pub runs: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<Held>,
    /// the cron minute a schedule last fired in (it fires once per minute)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_minute: Option<i64>,
    // ---- hooks only (webhook, slack, linear) ----
    /// the secret URL's token: POST /api/hooks/<token>
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub keyword: Option<String>,
    /// Slack member ids that may start it (slack only)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub users: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deliveries: Option<Vec<Delivery>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_hook_at: Option<i64>,
}

/// A trigger as the HTTP API and the UI see it (v1 triggerView): no secret, no seen list, no branch links.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct TriggerView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub base: TriggerBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub has_secret: Option<bool>,
    /// a Slack trigger saved before people had to be named: anyone in the channel can start it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub open: Option<bool>,
    /// what it has seen (CI runs, issues, tasks), counted
    pub watching: u32,
    #[ts(type = "number | null")]
    pub next_at: Option<i64>,
}

/// A saved prompt with `{params}` (v1 server/recipes.js).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// '' = whichever project it's run in
    pub cwd: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    /// '' | plan | edits | auto
    pub mode: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub runs: u32,
    #[ts(type = "number | null")]
    pub last_run_at: Option<i64>,
}

/// Who brought a read-only recipe (v1 `recipe.spell`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct RecipeFrom {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct RecipeView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub recipe: Recipe,
    pub params: Vec<String>,
    /// a recipe another plugin contributes (`automations.recipes@1`): read-only here
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plugin: Option<RecipeFrom>,
}

/// What a trigger needs of a crew member (sent by the crew, so nothing calls back).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct MemberRef {
    pub id: String,
    pub name: String,
    pub cwd: String,
    /// the member works on another machine: its folder isn't one here
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub machine: Option<String>,
}
