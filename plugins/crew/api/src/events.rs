//! wisp.crew's events: facts, published after the command that caused them commits (v1 crew.js
//! `#changed()` and its telemetry: `crew_shared`, `crew_imported`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Event;

use crate::rows::JobKind;

macro_rules! event {
    ($name:ident = $ty:literal) => {
        impl Event for $name {
            const TYPE: &'static str = $ty;
        }
    };
}

/// A member joined the crew (created, imported or adopted from a task).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Joined {
    pub crew_id: String,
    pub name: String,
    /// `create`, `import` or `task`
    pub how: String,
}
event!(Joined = "crew.joined");

/// A member's fields, queue or schedule changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct MemberChanged {
    pub crew_id: String,
}
event!(MemberChanged = "crew.changed");

/// A member left the crew. Automations drop its member triggers; the sandbox plugin its own sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Left {
    pub crew_id: String,
}
event!(Left = "crew.left");

/// A job started as a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct JobStarted {
    pub crew_id: String,
    pub session_id: String,
    pub job: JobKind,
}
event!(JobStarted = "crew.job_started");

/// A job finished and its line went into the member's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct JobFiled {
    pub crew_id: String,
    pub session_id: String,
    pub job: JobKind,
    pub status: String,
    /// nothing the user needs to see: logged, no notification
    pub quiet: bool,
    /// filed in For later, no notification
    pub for_later: bool,
}
event!(JobFiled = "crew.job_filed");

/// Members were shared (v1 telemetry `crew_shared`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Shared {
    pub members: u32,
    pub gist: bool,
    pub notebook: bool,
}
event!(Shared = "crew.shared");

/// Shared members joined (v1 telemetry `crew_imported`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct Imported {
    pub members: u32,
    /// `file`, `url` or `gist`
    pub source: String,
}
event!(Imported = "crew.imported");
