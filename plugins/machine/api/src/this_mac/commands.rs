//! This Mac's commands and events. Each id is also its permission (`machine.stop` → `machine:stop`),
//! checked by the kernel before the handler runs. None is in an agent's capability set: as in v1 (no
//! /internal or /control route), a task can't stop a process or pause automations. Bodies are v1's
//! (routes/machine.js), so the HTTP adapters stay thin.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::{Command, Event};

use super::service::LoadReading;
use super::view::MachineView;

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

/// `{}`
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct NoArgs {}

/// `POST /machine/stop {pid}`. The pid as sent: v1 took a number or a numeric string, and answered 400
/// for anything else, so it is checked by the handler, not by the decoder.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct StopArgs {
    #[serde(default)]
    #[ts(type = "number | string")]
    pub pid: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Stopped {
    pub stopped: u32,
    /// when the stopped process started (ms), so a client can tell it from a later one on that pid
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub since: Option<i64>,
}

/// `POST /machine/fix {group}`: a leftover group's id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct FixArgs {
    #[serde(default)]
    #[ts(type = "string")]
    pub group: Value,
}

/// Where the fix went: a crew member's job (`crew`, and `session` or `queued`), or a task (`session`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct FixFiled {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub queued: Option<Value>,
}

/// `POST /machine/harness/clean {ids?}`: the harnesses to clean (none: every one).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct HarnessCleanArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Cleaned {
    pub removed: u32,
    #[ts(type = "number")]
    pub freed: u64,
}

/// `POST /automations/pause {until}`: ms since the epoch, at most 30 days on, or 0 to resume.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct PauseArgs {
    #[serde(default)]
    #[ts(type = "number")]
    pub until: Value,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct Paused {
    /// 0: not paused
    #[ts(type = "number")]
    pub paused_until: i64,
}

command!(
    /// `GET /machine`. A read keeps the 10 s sampling going for 30 s; a stale snapshot is taken first.
    Read = "machine.read": NoArgs => MachineView, read_only
);
command!(
    /// A process a finished run left behind, or one in a running task's tree: SIGTERM, SIGKILL 5 s on.
    Stop = "machine.stop": StopArgs => Stopped
);
command!(
    /// A job for the crew's Bugsy, else a task in the project the processes came from.
    Fix = "machine.fix": FixArgs => FixFiled
);
command!(
    /// The harnesses' crash dumps and stale cwd files (through `machine.harnessDisk@1`).
    HarnessClean = "machine.harness.clean": HarnessCleanArgs => Cleaned
);
command!(
    /// Pause automations until a time (`POST /automations/pause`), or resume them with 0.
    AutomationsPause = "machine.automations.pause": PauseArgs => Paused
);
command!(
    /// `GET /load`: what the RAM/CPU guard reads and holds.
    Load = "machine.load": NoArgs => LoadReading, read_only
);

/// Held work may go: the guard held, and the last reading (or a resume, or the charger) frees it.
/// Crew, triggers and Later release what they held for the machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct LoadFree {
    pub reading: LoadReading,
}

impl Event for LoadFree {
    const TYPE: &'static str = "machine.load_free";
}

/// Automations were paused until a time, or resumed (`pausedUntil: 0`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct AutomationsPaused {
    pub paused: Paused,
}

impl Event for AutomationsPaused {
    const TYPE: &'static str = "machine.automations_paused";
}
