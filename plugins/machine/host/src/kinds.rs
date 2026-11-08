//! wisp.machine's resource kind (ADR-0028): the computers wisp runs on and their limits (v1 `maxRuns`,
//! `cpuCeiling`, `memoryFloor`, `batteryHold`, `computer`, `remote`). Kept as declared (`StoredKind`);
//! it changes where work may run, so a foreign formula needs `--trust`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// What a computer may take on before automations wait.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineLimits {
    /// runs at once (default: one per 3 GB of memory)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<u32>,
    /// automations wait while the CPU stays over this percent of its cores
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_ceiling: Option<u32>,
    /// automations wait while free memory is under this percent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_floor: Option<u32>,
    /// on battery under this percent, check-ins and the crew queue wait (off, 20 or 40)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery_hold: Option<u32>,
    /// one heavy step (a build, the tests) at a time
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_lock: Option<bool>,
}

/// A computer: this one (`this`) or a peer wisp reaches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineSpec {
    /// local | ssh | grid | grid-tunnel
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub transport: String,
    /// its address (host, ssh target or grid name)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<MachineLimits>,
    /// this computer is on the grid, so other computers reach it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_grid: Option<bool>,
}

pub fn register(s: &mut Setup) {
    let _ = stored::<MachineSpec>(s, |sc| KindInfo::new("machine", "machines", "wisp.machine", sc).order(8).sensitive());
}
