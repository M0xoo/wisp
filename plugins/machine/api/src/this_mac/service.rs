//! `machine.service@1`: the RAM/CPU guard and the user's holds, asked by whatever starts work nobody
//! started by hand (crew check-ins and queue, triggers, goal rounds, agents' own follow-ups). Every
//! answer is a read of the last 10 s sample: cheap enough for a crew view on every render, and safe
//! inside an interceptor.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::{Call, Result, Service};

use super::view::HoldKind;

/// The permission every [`MachineApi`] method requires.
pub const PERM_LOAD: &str = "machine:load";

/// What holds back work nobody started by hand (v1 Load.hold / Machine.hold). `until` is when it looks
/// again: a hold of the machine has no reset to wait for, so it is a minute on at most.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Hold {
    /// always true: tells a consumer this is the machine's hold, not a plan's (`PlanHold.load`)
    pub load: bool,
    pub kind: HoldKind,
    pub why: String,
    #[ts(type = "number")]
    pub until: i64,
}

/// A run started by hand goes anyway; when memory is under the floor the page says so (a toast).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Short {
    pub why: String,
}

/// The three knobs as numbers (null: off). `maxRuns: auto` is resolved for this machine's memory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct Limits {
    pub floor: Option<u32>,
    pub ceiling: Option<u32>,
    pub max_runs: Option<u32>,
}

/// `{kind, why}` of a hold, as `GET /load` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Held {
    pub kind: HoldKind,
    pub why: String,
}

/// `GET /load` (v1 Load.reading): the last sample, the runs going, the limits in force and the hold.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct LoadReading {
    #[serde(serialize_with = "super::num::opt")]
    pub mem_free_pct: Option<f64>,
    #[serde(serialize_with = "super::num::opt")]
    pub cpu: Option<f64>,
    /// Linux PSI `some avg10`, when the kernel has it
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "super::num::opt")]
    #[ts(optional)]
    pub pressure: Option<f64>,
    /// when it was sampled (ms); 0 before the first sample
    #[ts(type = "number")]
    pub at: i64,
    pub runs: u32,
    pub limits: Limits,
    pub held: Option<Held>,
}

/// The guard's read-only questions. Every method starts with `call.require(PERM_LOAD)?`.
pub trait MachineApi: Send + Sync + 'static {
    /// What holds unattended work back (a pause, the battery, memory, CPU, run slots), or `None`.
    fn hold(&self, call: &Call) -> Result<Option<Hold>>;
    /// The machine is short (memory under the floor, or the CPU over its ceiling): the worktree sweep
    /// and its `du` wait. Full run slots aren't "busy": a sweep costs disk, not a run.
    fn busy(&self, call: &Call) -> Result<bool>;
    /// Memory under the floor: what to tell someone who starts a run by hand.
    fn short(&self, call: &Call) -> Result<Option<Short>>;
    fn reading(&self, call: &Call) -> Result<LoadReading>;
}

/// `machine.service@1`, requested by contract (plan §6.11.1).
#[derive(Debug)]
pub struct MachineService;

impl Service for MachineService {
    const ID: &'static str = "machine.service";
    const MAJOR: u32 = 1;
    type Api = dyn MachineApi;
}
