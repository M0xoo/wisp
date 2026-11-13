//! wisp.crew's commands, one per v1 route (server/routes/crew.js). Bodies are v1's (camelCase) plus
//! the ids the route took from its path, so the HTTP adapters stay thin. Each command names the
//! permission it needs: reads `crew:read`, changes `crew:write`, handing work `crew:assign`.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Command;

use crate::rows::{JobSummary, MemberView};
use crate::{PERM_ASSIGN, PERM_PROPOSE, PERM_READ, PERM_WRITE};

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal [$perm:expr] : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            fn args_ts() -> Option<String> {
                Some(format!("{}{}", <$args as ::ts_rs::TS>::docs().unwrap_or_default(), <$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
            }
            type Out = $out;
        }
    };
}

/// `"wakeAt": null` clears the wake-up; leaving the key out keeps it.
#[allow(clippy::option_option)] // absent, null and a time are three different edits
fn some_null<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    Option::<i64>::deserialize(d).map(Some)
}

/// A member's fields as a create or an edit sends them (v1 `normalizeMember`'s input). Every field is
/// optional: an edit keeps what it leaves out.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct MemberBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// the list's tint while they're picked (v1 `bg`): '' their glow, 'none', or a crew colour. Additive (2026-11-12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sandbox: Option<String>,
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
    /// a cron, or words ("every 30 minutes")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cron: Option<String>,
    /// v1 takes any number and floors it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parallel: Option<f64>,
    /// `[{ name, description?, body }]`, checked by `normalize_kit`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Array<unknown>")]
    pub kit: Option<Value>,
    /// `[{ crew, why? }]`, checked by `normalize_team`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Array<unknown>")]
    pub team: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notebook: Option<String>,
    /// `null` clears the wake-up it asked for
    #[serde(default, deserialize_with = "some_null", skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | null")]
    #[allow(clippy::option_option)]
    pub wake_at: Option<Option<i64>>,
    /// v1's trigger kinds that start its jobs (`ci`, `done`, `finished`): read as `wakes`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub on: Option<Vec<String>>,
    /// what else wakes them (ADR-0043): trigger specs, their target this member
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Array<unknown>")]
    pub wakes: Option<Vec<wisp_automations_api::TriggerSpec>>,
}

/// Where a member sits on the Org page: x from the chart's middle, y from its top, in px.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct Point {
    #[ts(type = "number")]
    pub x: i64,
    #[ts(type = "number")]
    pub y: i64,
}

/// `{ [member id]: { x, y } }`. Empty: the chart lays itself out.
pub type Layout = BTreeMap<String, Point>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct NoArgs {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct IdArgs {
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Ok {
    pub ok: bool,
}

/// `GET /crew-kit?cwd=`: skills and instructions files on this computer, and the project's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct KitArgs {
    #[serde(default)]
    pub cwd: String,
}

/// One file `crew.kit` found, to add to a member's kit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct LocalKitFile {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub path: String,
    /// `home` or `project`
    pub from: String,
    /// its text, as the kit takes it (a skill without its front matter); empty when it couldn't be read
    #[serde(default)]
    pub body: String,
}

/// `PUT /crew-layout`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct LayoutArgs {
    #[ts(type = "Record<string, { x: number, y: number }>")]
    pub layout: Value,
}

/// `POST /crew`. `checkin: true` starts a first check-in at once.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct CreateArgs {
    #[serde(flatten)]
    pub member: MemberBody,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checkin: Option<bool>,
}

/// A member, and the task its first check-in started (if asked).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Created {
    #[serde(flatten)]
    pub member: MemberView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub session: Option<Value>,
}

/// An offer the user added or dismissed (after the kit it added to was accepted).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct OfferSettle {
    pub id: String,
    /// `added` or `dismissed`
    pub state: String,
    #[serde(default)]
    pub names: Vec<String>,
}

/// `crew.agent.kit`: the `wisp_crew_kit` tool (v1 POST /internal/crew/:id/kit). `session` is the caller's task: the
/// offer shows under its latest turn.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct AgentKitArgs {
    pub session: String,
    /// their name, @handle or id
    pub member: String,
    #[serde(default)]
    #[ts(type = "unknown[]")]
    pub files: Vec<Value>,
}

/// `crew.agent.add`: the `wisp_crew_add` tool (v1 POST /internal/crew/:id). `session` is the caller's task (its
/// project is the default folder). With `from` (a share link, `gist:<id>`, an https `.crew.json`, or its JSON) the
/// members someone shared join through `crew.import`, paused; without it, a member is made from the fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct AgentAddArgs {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checkin: Option<bool>,
    #[serde(flatten)]
    pub member: MemberBody,
}

/// What the agent reads back: `text`, or `error` for a refusal it acts on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct AgentText {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// `PATCH /crew/:id`. `queue`: the waiting job ids to keep (the rest are dropped).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct UpdateArgs {
    pub id: String,
    #[serde(flatten)]
    pub member: MemberBody,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offers: Option<Vec<OfferSettle>>,
}

/// `GET /crew/:id`: the member and its 50 newest jobs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct MemberDetail {
    #[serde(flatten)]
    pub member: MemberView,
    pub job_list: Vec<JobSummary>,
}

/// `GET /crew/stats?days=` (1..=365, default 30).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct StatsArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub days: Option<u32>,
}

/// One member's track record over the range, and the range before it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct MemberStats {
    pub id: String,
    pub jobs: u32,
    pub done: u32,
    pub failed: u32,
    pub quiet: u32,
    #[serde(default)]
    pub before: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost: Option<f64>,
    /// tokens its jobs in the range used (input, output and cache); additive (2026-11-13)
    #[serde(default)]
    #[ts(type = "number")]
    pub tokens: u64,
    /// where they went, by where the job came from (`checkin`, `task`, …)
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[ts(as = "Option<std::collections::BTreeMap<String, KindUse>>", optional)]
    pub by_kind: std::collections::BTreeMap<String, KindUse>,
    /// its biggest jobs in the range, most tokens first (5 at most)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<TopJob>>", optional)]
    pub top: Vec<TopJob>,
    /// the range's length in days, for per-day rates
    #[serde(default)]
    pub days: u32,
}

/// One kind of job's runs and tokens over the range.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct KindUse {
    pub runs: u32,
    #[ts(type = "number")]
    pub tokens: u64,
    /// check-ins (or checks) that found nothing to do
    pub quiet: u32,
}

/// One of a member's biggest jobs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct TopJob {
    pub id: String,
    pub title: String,
    pub job: crate::JobKind,
    #[ts(type = "number")]
    pub tokens: u64,
}

/// `POST /crew/:id/jobs`. `kit: true` with no prompt: "Build your kit".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct AssignArgs {
    pub id: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, type = "Array<unknown>")]
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub kit: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub confirm_limit: bool,
    /// this job's own harness, model, level or mode, instead of the member's (v1 `crewRun`, #764)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run: Option<crate::RunPick>,
    /// `run` is what you picked in wisp's own prompt box: it may change the harness (a channel's may not)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub picked: bool,
}

/// A job started, or queued behind the member's `parallel` limit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Started {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub session: Option<Value>,
    /// the waiting job's id when it queued
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queued: Option<String>,
    /// where in the queue
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<u32>,
}

/// `POST /crew/export`: ids are ids, names or handles.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct ExportArgs {
    #[serde(default)]
    pub ids: Vec<String>,
    /// the kit goes too (default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notebook: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub team: Option<bool>,
    /// also as a secret gist
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gist: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct Exported {
    #[ts(type = "Record<string, unknown>")]
    pub bundle: Value,
    pub notes: Vec<String>,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub gist: Option<Value>,
}

/// `POST /crew/import`: pasted `text`, a `url` (https or gist:<id>), or a `bundle`. `dryRun` answers
/// the review; `choices` (`{ [key]: { name, cwd, skip } }`) are the review's answers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct ImportArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub bundle: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub choices: Option<Value>,
    /// a password-locked share link's password (asked when a review answers `locked: "password"`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub password: Option<String>,
}

/// The review (`members` plan, `room` left), a spell to review, or the members that joined. A review of a link the
/// grid won't open without a password answers `locked: "password"` (and `wrong` when the one given didn't open it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Imported {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, type = "Array<unknown>")]
    pub members: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub spell: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub room: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub wrong: bool,
}

/// `crew.ask`: a message in a task that's for a member (`@ada can you check this?`): it becomes their job, and their
/// answer lands under that message. Additive (2026-11-11).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct AskArgs {
    pub session_id: String,
    /// the member's id, name or @handle
    pub id: String,
    pub text: String,
    /// the turn it's asked under (the task's latest when left out)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<String>,
}

/// `POST /sessions/:id/crew-reply`: you reply to a member's answer on a task.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct ReplyArgs {
    pub session_id: String,
    #[serde(default)]
    pub entry: String,
    pub text: String,
}

/// `POST /sessions/:id/crew`: a task joins the crew as the new member's first job.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct AdoptArgs {
    pub session_id: String,
    #[serde(flatten)]
    pub member: MemberBody,
}

command!(
    /// `GET /crew`
    List = "crew.list" [PERM_READ] : NoArgs => Vec<MemberView>, ro
);
command!(
    /// `GET /crew/:id`
    Get = "crew.get" [PERM_READ] : IdArgs => MemberDetail, ro
);
command!(
    /// `GET /crew-kit`
    LocalKit = "crew.kit" [PERM_READ] : KitArgs => Vec<LocalKitFile>, ro
);
command!(
    /// `POST /internal/crew/:id/kit`: files an agent proposes for a member's kit, an offer the user picks from
    AgentKit = "crew.agent.kit" [PERM_PROPOSE] : AgentKitArgs => AgentText
);
command!(
    /// `POST /internal/crew/:id`: an agent adds a member, or takes in the members a link or crew file holds
    AgentAdd = "crew.agent.add" [PERM_WRITE] : AgentAddArgs => AgentText
);
command!(
    /// `GET /crew-layout`
    GetLayout = "crew.layout" [PERM_READ] : NoArgs => Layout, ro
);
command!(
    /// `GET /crew/stats`
    Stats = "crew.stats" [PERM_READ] : StatsArgs => Vec<MemberStats>, ro
);
command!(
    /// `PUT /crew-layout`
    SetLayout = "crew.set_layout" [PERM_WRITE] : LayoutArgs => Layout
);
command!(
    /// `POST /crew` (at most [`crate::MAX_CREW`])
    Create = "crew.create" [PERM_WRITE] : CreateArgs => Created
);
command!(
    /// `PATCH /crew/:id`
    Update = "crew.update" [PERM_WRITE] : UpdateArgs => MemberView
);
command!(
    /// `DELETE /crew/:id` (its own sandbox goes with it)
    Remove = "crew.remove" [PERM_WRITE] : IdArgs => Ok
);
command!(
    /// `POST /crew/:id/detach`: a spell's member becomes yours
    Detach = "crew.detach" [PERM_WRITE] : IdArgs => MemberView
);
command!(
    /// `POST /crew/export` (refused while the secret scan finds anything)
    Export = "crew.export" [PERM_READ] : ExportArgs => Exported
);
command!(
    /// `POST /crew/import` (they join paused)
    Import = "crew.import" [PERM_WRITE] : ImportArgs => Imported
);
command!(
    /// `POST /sessions/:id/crew`
    Adopt = "crew.adopt" [PERM_WRITE] : AdoptArgs => MemberView
);
command!(
    /// `POST /crew/:id/jobs` (the 21st waiting job is refused, status 429)
    Assign = "crew.assign" [PERM_ASSIGN] : AssignArgs => Started
);
command!(
    /// `POST /crew/:id/checkin` (a second one while one runs is refused, status 409)
    Checkin = "crew.checkin" [PERM_ASSIGN] : IdArgs => Started
);
command!(
    /// `POST /sessions/:id/crew-reply`
    Reply = "crew.reply" [PERM_ASSIGN] : ReplyArgs => crate::CrewAnswer
);
command!(
    /// A message in a task for a member: their job, its answer under the message (v1 `/btw @ada`)
    Ask = "crew.ask" [PERM_ASSIGN] : AskArgs => crate::CrewAnswer
);

/// Every command id this crate declares, for the manifest and capability sets.
pub const ALL: [&str; 17] = [
    List::ID,
    Get::ID,
    LocalKit::ID,
    GetLayout::ID,
    Stats::ID,
    SetLayout::ID,
    Create::ID,
    Update::ID,
    Remove::ID,
    Detach::ID,
    Export::ID,
    Import::ID,
    Adopt::ID,
    Assign::ID,
    Checkin::ID,
    Reply::ID,
    Ask::ID,
];

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn wake_at_null_clears_and_absent_keeps() {
        let clear: MemberBody = serde_json::from_str(r#"{"wakeAt":null}"#).unwrap();
        assert_eq!(clear.wake_at, Some(None));
        let keep: MemberBody = serde_json::from_str("{}").unwrap();
        assert_eq!(keep.wake_at, None);
        let set: MemberBody = serde_json::from_str(r#"{"wakeAt":5}"#).unwrap();
        assert_eq!(set.wake_at, Some(Some(5)));
    }

    #[test]
    fn update_takes_v1_patch_body() {
        let a: UpdateArgs = serde_json::from_str(r#"{"id":"m1","name":"Ada","queue":["w1"],"paused":true}"#).unwrap();
        assert_eq!(a.member.name.as_deref(), Some("Ada"));
        assert_eq!(a.queue, Some(vec!["w1".to_owned()]));
        assert_eq!(a.member.paused, Some(true));
    }

    #[test]
    fn ids_are_unique() {
        let mut v = ALL.to_vec();
        v.sort_unstable();
        v.dedup();
        assert_eq!(v.len(), ALL.len());
    }
}

/// `crew.wake`: a job for a member because something happened (a trigger, an outside harness, `wisp crew wake`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct WakeArgs {
    /// the member's id, name or @handle
    pub id: String,
    /// why: what happened, as the job's prompt
    #[serde(default)]
    pub why: String,
    /// where it came from (`trigger:review`, `chat`, `mcp`), recorded on the job
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
}

/// `crew.wakeMentions`: every member a text mentions (`@ada`) gets a job.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct MentionArgs {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
}

command!(
    /// A member wakes: a job, now or in their queue (ADR-0043)
    Wake = "crew.wake" [PERM_ASSIGN] : WakeArgs => Started
);
command!(
    /// Members mentioned in a text wake (`@ada please look`)
    WakeMentions = "crew.wakeMentions" [PERM_ASSIGN] : MentionArgs => Vec<Started>
);

/// One hand-off: `to` wakes when `from` reports (`crew.reported` with `match: {member: from}`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct WakeEdge {
    pub from: String,
    pub to: String,
}

/// `wisp crew graph`: who wakes whom, each member's other wakes, and a loop if one slipped in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct WakeGraph {
    pub edges: Vec<WakeEdge>,
    /// member → the `on` of each of its wakes
    pub wakes: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cycle: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct GraphArgs {}

command!(
    /// Who wakes whom (ADR-0043)
    Graph = "crew.graph" [PERM_READ] : GraphArgs => WakeGraph, read
);
