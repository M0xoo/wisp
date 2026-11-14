//! The crew's rows, as v1 stored them in config.json (`config.crew[]`), camelCase on the wire.
//!
//! size-ok: the contract's row types, kept in one file so ts-rs exports them together

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Where a job came from (v1 `JOBS`, crew.js:40).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "crew/")]
pub enum JobKind {
    /// on its schedule, or a wake-up it asked for
    Checkin,
    /// from the user, sent to it directly
    #[default]
    Task,
    /// a lead task's agent handed it work
    Delegated,
    /// a trigger started it
    Trigger,
    /// the user tagged it (@Ada) in a task
    Mention,
    /// a task it watches finished or was marked done
    Event,
}

impl JobKind {
    /// v1 `JOBS.has(job) ? job : 'task'`: an unknown kind is a task.
    pub fn parse(s: &str) -> Self {
        match s {
            "checkin" => Self::Checkin,
            "delegated" => Self::Delegated,
            "trigger" => Self::Trigger,
            "mention" => Self::Mention,
            "event" => Self::Event,
            _ => Self::Task,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Checkin => "checkin",
            Self::Task => "task",
            Self::Delegated => "delegated",
            Self::Trigger => "trigger",
            Self::Mention => "mention",
            Self::Event => "event",
        }
    }
    /// Jobs nobody waits on: one that found nothing is filed quietly or For later (v1 `QUIET_JOBS`).
    pub fn nobody_waits(self) -> bool {
        matches!(self, Self::Checkin | Self::Event)
    }
    /// Jobs that start even while the member is paused: the user's own (v1 crew.js:615).
    pub fn runs_paused(self) -> bool {
        matches!(self, Self::Task | Self::Mention)
    }
}

/// A file of a member's kit: an instructions file (`rules`) it follows on every job, or a skill it
/// reads when a job fits its description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct KitFile {
    pub id: String,
    /// `skill` or `rules`
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub body: String,
    /// a skill imported from this computer keeps its folder, for the files beside its SKILL.md
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    pub on: bool,
}

/// A file a job proposed for the kit (no id, path or on yet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct OfferFile {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub body: String,
}

/// One of a member's delegates (v1 subagents.js `normalizeTeam`'s row).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct TeamRow {
    pub name: String,
    pub agent: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default, rename = "use", skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional, rename = "use")]
    pub use_: String,
    #[serde(default = "one")]
    pub count: u32,
    /// another crew member's id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role: Option<String>,
}

fn one() -> u32 {
    1
}

/// Skipped for the plan (Automations stop at) or a busy computer, until `until`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Held {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub at: Option<i64>,
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub load: bool,
}

/// Files a job proposed for the member's kit, kept until you add or dismiss them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Offer {
    pub id: String,
    /// the task whose turn proposed it
    pub job: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn: Option<String>,
    #[ts(type = "number")]
    pub at: i64,
    pub files: Vec<OfferFile>,
    /// `open`, `taken` or `dismissed`
    pub state: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub settled_at: Option<i64>,
}

/// A spell's member: which spell, its key there, and the definition it last applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct SpellLock {
    pub id: String,
    pub key: String,
    pub name: String,
    #[ts(type = "Record<string, unknown>")]
    pub def: Value,
}

/// A spell changed what the member does: paused until you've seen it (`from`: the old definition).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Changed {
    #[ts(type = "Record<string, unknown> | null")]
    pub from: Value,
    #[ts(type = "number")]
    pub at: i64,
}

/// Another task: where a job came from, a link it may follow up on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct TaskRef {
    pub id: String,
    #[serde(default)]
    pub title: String,
}

/// One line of the member's log: a finished job, or check-ins skipped in a row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct LogEntry {
    #[ts(type = "number")]
    pub at: i64,
    pub job: JobKind,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    /// what it was asked
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<TaskRef>,
    pub status: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub quiet: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub for_later: bool,
    /// skips in a row share one line
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub skipped: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
}

/// A member's answer under the message that asked it (v1 `turn.btw` with `crew`), kept on that turn in crew's own
/// ext slot (`turn.ext["wisp.crew"].answers`). A reply to it threads right after it and carries on the same job.
/// Additive (2026-11-11).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct CrewAnswer {
    pub id: String,
    /// the member's id
    pub crew: String,
    /// their name when asked (the member may be renamed or gone later)
    #[serde(default)]
    pub member: String,
    /// the job answering it, once it started
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub job: Option<String>,
    pub question: String,
    #[serde(default)]
    pub answer: String,
    /// `running`, `done` or `error`
    pub status: String,
    /// the first entry of the thread this one continues
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread: Option<String>,
    #[ts(type = "number")]
    pub asked_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub answered_at: Option<i64>,
}

/// Where a job's answer goes: an entry under a message in another task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct ReplyTo {
    pub session_id: String,
    pub turn_id: String,
    pub entry_id: String,
}

/// One job's own model, effort or mode ("@ada with opus plan: …"); `agent` only from wisp's own prompt box (#764).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct RunPick {
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

/// A job waiting in a member's queue (v1 crew.js:613).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct WaitingJob {
    pub id: String,
    pub prompt: String,
    pub job: JobKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub origin: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, type = "Array<unknown>")]
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reply: Option<ReplyTo>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub wake: bool,
    /// what a task watcher saw happen to `from`: `finished` or `done`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub kit: bool,
    /// members tagged in it, who join this job's delegates
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<TeamRow>>", optional)]
    pub team: Vec<TeamRow>,
    /// nobody asked for it just now: held while its account is past Automations stop at
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub unattended: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run: Option<RunPick>,
    /// the channel thread it came from, which its answer goes back to
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub thread: Option<Value>,
    #[ts(type = "number")]
    pub at: i64,
}

/// A task that tagged or delegated to the member: it may follow up there (newest first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Link {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[ts(type = "number")]
    pub at: i64,
}

/// A crew member, with its schedule and bookkeeping (v1 `normalizeMember`, crew.js:98-133).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Member {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// a spirit code, an emoji, or '' (rolled from the name)
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub color: String,
    /// the list's tint while they're picked on the rail (v1 `bg`): '' their glow, 'none', or a crew colour. Additive.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub bg: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub cwd: String,
    /// '' = this computer
    #[serde(default)]
    pub machine: String,
    /// '' | 'job' | 'own'
    #[serde(default)]
    pub sandbox: String,
    pub agent: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    pub mode: String,
    /// a checked 5-field cron, '' for none
    #[serde(default)]
    pub cron: String,
    pub parallel: u32,
    #[serde(default)]
    pub kit: Vec<KitFile>,
    #[serde(default)]
    pub team: Vec<TeamRow>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub notebook: String,
    #[serde(default)]
    pub log: Vec<LogEntry>,
    #[serde(default)]
    pub queue: Vec<WaitingJob>,
    /// jobs running on its machine: job id → { reply? }
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub away: BTreeMap<String, Value>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub offers: Vec<Offer>,
    #[ts(type = "number | null")]
    pub wake_at: Option<i64>,
    #[serde(default)]
    pub checkins: u32,
    #[ts(type = "number | null")]
    pub last_checkin_at: Option<i64>,
    /// the minute (ms / 60 000) its last scheduled check-in ran in: that minute is no longer due
    #[ts(type = "number | null")]
    pub last_minute: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<Held>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub spell: Option<SpellLock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub changed: Option<Changed>,
    /// what else wakes them (ADR-0043): triggers whose target is this member
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, type = "Array<unknown>")]
    pub wakes: Vec<wisp_automations_api::TriggerSpec>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

impl Member {
    /// Their jobs run away from here: on a machine, or in a sandbox (v1 `elsewhere`).
    pub fn elsewhere(&self) -> bool {
        !self.machine.is_empty() || !self.sandbox.is_empty()
    }
}

/// A member as the page and the API see it (v1 `Crew.view`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct MemberView {
    #[serde(flatten)]
    pub member: Member,
    /// jobs running or asking, plus ones being started
    pub running: u32,
    /// every job it has
    pub jobs: u32,
    #[ts(type = "number | null")]
    pub next_at: Option<i64>,
    pub handle: String,
    /// what else starts its jobs (trigger kinds)
    pub on: Vec<String>,
}

/// What the crew keeps on a job's task (v1 `session.crew`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct CrewExt {
    pub id: String,
    pub job: JobKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reply: Option<ReplyTo>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub wake: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub kit: bool,
    /// tasks it followed up on
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<TaskRef>>", optional)]
    pub sent: Vec<TaskRef>,
    /// what it was asked (a job you or a task gave it; a check-in's own prompt is left out), up to 2000
    /// characters: its page shows it over the answer (v1 `session.crew.prompt`). Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    /// a job away from here (a member on a machine, or in a sandbox): the member's note (identity, brief, notebook,
    /// kit), written here and carried with the job, since the wisp it runs on has no such member (v1 `crewJob.note`).
    /// Additive (2026-11-14).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// One job of a member as the scheduler sees it: which member, what kind, whether it is live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct JobSummary {
    pub session_id: String,
    pub crew_id: String,
    pub job: JobKind,
    /// `running`, `waiting`, `review` or `done`
    pub state: String,
}

impl JobSummary {
    /// running or asking: it holds one of the member's `parallel` slots
    pub fn live(&self) -> bool {
        self.state == "running" || self.state == "waiting"
    }
}
