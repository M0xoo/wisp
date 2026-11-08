//! Commands (an action), events (a fact). Every route of `/api/plugins*` and `/api/spells*` is a thin
//! adapter over one of these; their JSON is v1's.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::{Command, Event};

use crate::{ListOut, LockedBy, PluginView, Risk, Source, perm};

macro_rules! command {
    ($(#[$m:meta])* $name:ident, $id:literal, $perm:expr, $ro:literal, $args:ty => $out:ty) => {
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct NoArgs {}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct IdArgs {
    pub id: String,
}

/// What a request body names: `{ spell }`, `{ plugin }`, `{ text }` (pasted, with its file `name`),
/// `{ url }` (an https link or `gist:<id>`, fetched) or `{ dir }` (a folder in ~/.wisp/plugins).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct Given {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | undefined")]
    pub spell: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | undefined")]
    pub plugin: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub name: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub source: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct InstallArgs {
    #[serde(flatten)]
    pub given: Given,
    /// only `true` switches it on: only the user's own click sends that
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub enable: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InstallOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | undefined")]
    pub spell: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginView>,
    pub warnings: Vec<String>,
    pub updated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct SetEnabledArgs {
    pub id: String,
    /// must be a boolean (v1 answered 400 otherwise)
    #[serde(default)]
    #[ts(type = "unknown")]
    pub enabled: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct RemoveArgs {
    pub id: String,
    /// 'remove' takes the spell's crew members too; 'keep' (default) leaves them as the user's
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crew: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct OkOut {
    pub ok: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct DataArgs {
    pub id: String,
    pub name: String,
    /// the card's task, for per-task sources
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct TryDataArgs {
    #[ts(type = "Record<string, unknown>")]
    pub spell: Value,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DataOut {
    #[ts(type = "unknown")]
    pub value: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct OpenArgs {
    #[ts(type = "unknown")]
    #[serde(default)]
    pub urls: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct OpenOut {
    pub opened: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct GuideArgs {
    /// how this harness names wisp's ask tool (`mcp__wisp__ask_user`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TextOut {
    pub text: String,
}

/// Settings the plugins that are on set, and who set each (the last one switched on wins).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocksOut {
    #[ts(type = "Record<string, unknown>")]
    pub values: BTreeMap<String, Value>,
    pub locked_by: BTreeMap<String, LockedBy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct MakeArgs {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// What happened to a task, for spell hooks (v1 spell-hooks.js). The runtime calls `plugins.fire`
/// after its own handlers: `turn.finished`, `turn.failed`, `session.started`, `session.waiting`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FireArgs {
    pub on: String,
    pub session: HookTask,
}

/// The facts a hook's `if` tests and its `{field}` templates read.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // v1's wire shape: each flag is its own field
pub struct HookTask {
    pub id: String,
    pub agent: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub archived: bool,
    /// running in the runner right now
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub has_pr: bool,
    /// a delegate, a Make a plugin or pane task, or wisp's own: hooks never fire on those
    #[serde(default)]
    pub internal: bool,
    /// the ending turn's status ('done', 'error', …)
    #[serde(default)]
    pub turn_status: String,
    /// the ending turn's report has a tests block with failures
    #[serde(default)]
    pub tests_failed: bool,
    /// v1 `summarize()`: the fields templates fill from (status, project, projectId, pr, branch …)
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub summary: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FireOut {
    /// `<plugin>:<hook>` of each hook that fired
    pub fired: Vec<String>,
}

command!(List, "plugins.list", perm::READ, true, NoArgs => ListOut);
command!(Get, "plugins.get", perm::READ, true, IdArgs => Value);
command!(
    /// Validate without installing: `CheckOk` `{ ok: true, spell, summary, kind, warnings, installed }` or
    /// `CheckBad` `{ ok: false, problems, error }`.
    Check, "plugins.check", perm::READ, true, Given => Value
);
command!(Install, "plugins.install", perm::INSTALL, false, InstallArgs => InstallOut);
command!(SetEnabled, "plugins.setEnabled", perm::WRITE, false, SetEnabledArgs => Value);
command!(
    /// Every user plugin off: the way out when one makes the page unusable.
    AllOff, "plugins.allOff", perm::WRITE, false, NoArgs => ListOut
);
command!(Remove, "plugins.remove", perm::INSTALL, false, RemoveArgs => OkOut);
command!(Export, "plugins.export", perm::READ, true, IdArgs => Value);
command!(Data, "plugins.data", perm::READ, true, DataArgs => DataOut);
command!(TryData, "plugins.tryData", perm::READ, true, TryDataArgs => DataOut);
command!(
    /// http(s) links in the default browser, at most 20.
    Open, "plugins.open", perm::OPEN, false, OpenArgs => OpenOut
);
command!(Reference, "plugins.reference", perm::READ, true, NoArgs => Value);
command!(Guide, "plugins.guide", perm::READ, true, GuideArgs => TextOut);
command!(Locks, "plugins.locks", perm::READ, true, NoArgs => LocksOut);
command!(Recipes, "plugins.recipes", perm::READ, true, NoArgs => Vec<Value>);
command!(Make, "plugins.make", perm::MAKE, false, MakeArgs => IdArgs);
command!(Fire, "plugins.fire", perm::FIRE, false, FireArgs => FireOut);

// ---------- events (published after commit) ----------

/// The set that is on changed: spell ids and plugin ids.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Changed {
    pub enabled: Vec<String>,
}
impl Event for Changed {
    const TYPE: &'static str = "plugins.changed";
}

/// Telemetry reads it as v1's `spell_installed`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Installed {
    pub id: String,
    pub source: String,
    pub enabled: bool,
    pub kind: Risk,
}
impl Event for Installed {
    const TYPE: &'static str = "plugins.installed";
}

/// wisp.crew lets a spell's members go (`crew: 'remove'`) or keeps them as the user's.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Removed {
    pub id: String,
    pub crew: String,
}
impl Event for Removed {
    const TYPE: &'static str = "plugins.removed";
}

/// A spell hook asks the task's owner to act: `reply` (with `text`), `done`, `archive`, `forLater`.
/// The runtime applies it (it owns tasks); `notify` comes as [`Toast`], `webhook` wisp.plugins posts.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookAction {
    pub plugin: String,
    pub hook: String,
    pub on: String,
    pub session: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
impl Event for HookAction {
    const TYPE: &'static str = "plugins.hookAction";
}

/// Telemetry reads it as v1's `spell_hook`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Hooked {
    pub on: String,
    pub action: String,
    pub plugin: String,
}
impl Event for Hooked {
    const TYPE: &'static str = "plugins.hook";
}

/// A hook's `notify`, for the open pages and a linked phone.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Toast {
    pub toast: String,
    pub plugin: String,
    pub session: String,
}
impl Event for Toast {
    const TYPE: &'static str = "plugins.toast";
}

/// The `source` of an install, as the events and telemetry name it.
pub fn source_kind(s: Option<&Source>) -> String {
    s.map_or_else(|| "local".to_owned(), |s| s.kind.clone())
}
