//! wisp.automations' commands. Reads are `automations:read` (read-only), writes `automations:write`,
//! Run now and running a recipe `automations:run`. The crew's calls (`syncMember` and friends) are
//! `automations:crew`. Bodies are v1's request bodies (routes/automations.js), so the routes stay thin.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;
use wisp_kernel::Command;

use crate::model::{MemberRef, RecipeView, TriggerView};

pub const PERM_READ: &str = "automations:read";
pub const PERM_WRITE: &str = "automations:write";
pub const PERM_RUN: &str = "automations:run";
pub const PERM_CREW: &str = "automations:crew";

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal, $perm:expr, $ro:expr, $args:ty => $out:ty) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            const READ_ONLY: bool = $ro;
            type Args = $args;
            type Out = $out;
        }
    };
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct IdArgs {
    pub id: String,
}

/// `{ok: true}` (v1's answer to a delete).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct Done {
    pub ok: bool,
}

/// How many rows a crew call changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct Count {
    pub n: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct ListArgs {
    /// only the triggers that send this crew member work
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
}

/// A trigger's body as v1's POST/PATCH took it (`kind`, `cwd`, `cron` in words or cron, `secret`, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct UpdateArgs {
    pub id: String,
    #[ts(type = "Record<string, unknown>")]
    pub body: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct RunNowOut {
    #[ts(type = "Array<Record<string, unknown>>")]
    pub started: Vec<Value>,
    pub trigger: TriggerView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct KeyArgs {
    /// a recipe's id, or its name (loosely: "Fix Bug" finds fix-bug)
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct RecipeUpdateArgs {
    pub key: String,
    #[ts(type = "Record<string, unknown>")]
    pub body: Map<String, Value>,
}

/// `POST /recipes/:key/run`: `{params | words, cwd, agent, model, effort, mode}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct RecipeRunArgs {
    pub key: String,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub params: Map<String, Value>,
    /// positional words (`wisp run release 0.8.0`), filled into the params in order
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub words: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct AgentArgs {
    pub agent: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "automations/")]
pub struct NextWake {
    #[ts(type = "number | null")]
    pub at: Option<i64>,
}

/// The crew editor's "Also starts when": one trigger of each kind in `on` sends the member work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct SyncMemberArgs {
    pub member: MemberRef,
    pub on: Vec<String>,
    /// the member's folder before this edit: a CI watcher on it follows the member
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prev_cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "automations/")]
pub struct CrewArgs {
    pub crew_id: String,
    /// the member's name, for "Ada left your crew."
    #[serde(default)]
    pub name: String,
}

command!(Triggers = "automations.triggers", PERM_READ, true, ListArgs => Vec<TriggerView>);
command!(TriggerCreate = "automations.trigger.create", PERM_WRITE, false, Map<String, Value> => TriggerView);
command!(TriggerUpdate = "automations.trigger.update", PERM_WRITE, false, UpdateArgs => TriggerView);
command!(TriggerRemove = "automations.trigger.remove", PERM_WRITE, false, IdArgs => Done);
command!(
    /// A schedule fires now; a watcher polls and acts on what it finds. Never held by the plan.
    RunNow = "automations.runNow", PERM_RUN, false, IdArgs => RunNowOut
);
command!(Recipes = "automations.recipes", PERM_READ, true, Empty => Vec<RecipeView>);
command!(RecipeGet = "automations.recipe", PERM_READ, true, KeyArgs => RecipeView);
command!(RecipeCreate = "automations.recipe.create", PERM_WRITE, false, Map<String, Value> => RecipeView);
command!(RecipeUpdate = "automations.recipe.update", PERM_WRITE, false, RecipeUpdateArgs => RecipeView);
command!(RecipeRemove = "automations.recipe.remove", PERM_WRITE, false, KeyArgs => Done);
command!(RecipeRun = "automations.recipe.run", PERM_RUN, false, RecipeRunArgs => Value);
command!(
    /// A window of this harness reset early: rows held for its plan stop saying so.
    Release = "automations.release", PERM_WRITE, false, AgentArgs => Count
);
command!(
    /// The next scheduled wake (`GET /api/status` nextWakeAt; the grid wakes the box then).
    NextWakeOf = "automations.nextWake", PERM_READ, true, Empty => NextWake
);
command!(SyncMember = "automations.syncMember", PERM_CREW, false, SyncMemberArgs => Empty);
command!(
    /// The member's `on`: the kinds of its triggers that are on.
    MemberKinds = "automations.memberKinds", PERM_CREW, true, CrewArgs => Vec<String>
);
command!(
    /// A member left the crew: its triggers go off, unassigned, and say why.
    MemberLeft = "automations.memberLeft", PERM_CREW, false, CrewArgs => Count
);
command!(
    /// Gone for good (an import undone): the member's triggers go, as if never made.
    ForgetMember = "automations.forgetMember", PERM_CREW, false, CrewArgs => Count
);
