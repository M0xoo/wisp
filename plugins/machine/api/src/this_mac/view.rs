//! `GET /machine` (v1 Machine.view, design/machine.md): the field order is the wire's, the page and
//! older clients read it as is. Bytes are integers; CPU is a percent of one core, rounded to 0.1.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct MachineView {
    #[ts(type = "number")]
    pub at: i64,
    pub mem: MemInfo,
    pub cpu: CpuInfo,
    pub disk: DiskInfo,
    pub wisp: WispUse,
    pub guard: Guard,
    /// the running tasks, heaviest first
    pub tasks: Vec<TaskUse>,
    /// crew members, their running jobs summed
    pub crew: Vec<CrewUse>,
    pub leftovers: Vec<Leftover>,
    pub leftover_groups: Vec<LeftoverGroup>,
    /// a day of 1-minute points
    pub history: Vec<HistoryPoint>,
    /// worktree folders Clean up can take, then the harnesses' own group
    pub reclaim: Vec<ReclaimGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct MemInfo {
    #[ts(type = "number")]
    pub total: u64,
    #[serde(serialize_with = "super::num::opt")]
    pub free_pct: Option<f64>,
    /// Linux PSI `some avg10`
    #[serde(serialize_with = "super::num::opt")]
    pub pressure: Option<f64>,
    /// what each process's `rss` is: `footprint` (macOS `phys_footprint`, Activity Monitor's Memory) or `rss`
    pub per: MemoryPer,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "machine/")]
pub enum MemoryPer {
    Footprint,
    #[default]
    Rss,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct CpuInfo {
    /// the 1-minute load over the cores, as a percent (macOS, Linux); the busy share on Windows
    #[serde(serialize_with = "super::num::opt")]
    pub pct: Option<f64>,
    pub cores: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct DiskInfo {
    #[ts(type = "number | null")]
    pub free: Option<u64>,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    /// every worktree folder, as Settings → Worktrees last measured
    #[ts(type = "number | null")]
    pub worktrees: Option<u64>,
    /// what the reclaim groups add up to
    #[ts(type = "number")]
    pub reclaimable: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct WispUse {
    #[ts(type = "number")]
    pub rss: u64,
    #[serde(serialize_with = "super::num::opt")]
    pub cpu: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct Guard {
    /// what holds automations: `paused`, `battery`, `memory`, `cpu`, `runs`, or null
    pub held: Option<HoldKind>,
    pub why: Option<String>,
    pub floor: Option<u32>,
    pub ceiling: Option<u32>,
    pub max_runs: Option<u32>,
    pub runs: u32,
    /// ms since the epoch; 0 when nothing is paused
    #[ts(type = "number")]
    pub paused_until: i64,
    pub battery: Option<BatteryState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "machine/")]
pub enum HoldKind {
    Paused,
    Battery,
    Memory,
    Cpu,
    Runs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct BatteryState {
    pub pct: u32,
    /// on the charger
    pub charging: bool,
    /// the batteryHold percent in force, or null when it is off
    pub hold: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct TaskUse {
    pub id: String,
    pub title: String,
    /// the crew member whose job it is
    pub crew: Option<String>,
    #[ts(type = "number")]
    pub rss: u64,
    #[serde(serialize_with = "super::num::f64")]
    pub cpu: f64,
    pub procs: u32,
    #[ts(type = "number | null")]
    pub worktree_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct CrewUse {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub rss: u64,
    #[serde(serialize_with = "super::num::f64")]
    pub cpu: f64,
    pub jobs: u32,
}

/// A process a finished run left running (or one orphaned under `<home>/worktrees`), 2 min or older.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Leftover {
    pub pid: u32,
    /// the command line, cut before its environment (never an env value), at most 200 characters
    pub command: String,
    #[ts(type = "number")]
    pub rss: u64,
    #[serde(serialize_with = "super::num::f64")]
    pub cpu: f64,
    pub task: Option<String>,
    /// when it started, ms since the epoch
    #[ts(type = "number")]
    pub since: i64,
}

/// Leftovers by what started them and their task (File a fix).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct LeftoverGroup {
    /// for `POST /machine/fix`: 10 hex characters, stable for the same task and command
    pub id: String,
    /// the program and script that started them, before the first flag
    pub command: String,
    pub task: Option<String>,
    pub count: u32,
    #[ts(type = "number")]
    pub rss: u64,
    #[serde(serialize_with = "super::num::f64")]
    pub cpu: f64,
    pub pids: Vec<u32>,
    /// up to 10 distinct command lines
    pub commands: Vec<String>,
    #[ts(type = "number")]
    pub since: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "machine/")]
pub struct HistoryPoint {
    #[ts(type = "number")]
    pub at: i64,
    #[serde(serialize_with = "super::num::opt")]
    pub free_pct: Option<f64>,
    #[serde(serialize_with = "super::num::opt")]
    pub cpu: Option<f64>,
    pub runs: u32,
    pub held: bool,
    #[ts(type = "number | null")]
    pub worktree_bytes: Option<u64>,
}

/// A heavy run's use, on its list row as `res` (over 500 MB or 50% of a core; resent on a 20% move).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct Res {
    #[ts(type = "number")]
    pub rss: u64,
    #[serde(serialize_with = "super::num::f64")]
    pub cpu: f64,
}

/// A group Clean up can take: `merged`, `done`, `crew`, `leftover` (ids for `POST /worktrees/clean`),
/// or `harness` (ids for `POST /machine/harness/clean`, with `total`, `measuredAt` and `harnesses`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "machine/")]
pub struct ReclaimGroup {
    pub kind: String,
    pub count: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    pub ids: Vec<String>,
    /// the harness group's own fields
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Map<String, Value>,
}
