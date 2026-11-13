//! wisp.machine's resource kind (ADR-0028): the computers wisp runs on and their limits (v1 `maxRuns`,
//! `cpuCeiling`, `memoryFloor`, `batteryHold`, `computer`, `remote`). Acted on: a machine reached over a
//! transport (`ssh`, `loopback`, `grid`…) becomes a peer of wisp.machines (`machines.add`, updated in
//! place by name, removed with it); `this` (or no transport) is this computer, whose limits are kept as
//! declared until the load guard is ported. It changes where work may run, so a foreign formula needs
//! `--trust`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::calls;
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Result, Setup};
use wisp_machines_api::AddArgs;
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

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
    /// its wisp's port (ssh, loopback), when it isn't the default
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<MachineLimits>,
    /// this computer is on the grid, so other computers reach it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_grid: Option<bool>,
}

/// A peer, not this computer.
fn is_peer(m: &MachineSpec) -> bool {
    !matches!(m.transport.as_str(), "" | "this" | "local")
}

struct MachineKind(Arc<StoredKind>);

impl MachineKind {
    async fn peer(&self, op: &Op) -> Result<()> {
        let ctx = &self.0.ctx;
        let call = ctx.root_call();
        let m: MachineSpec = serde_json::from_value(op.spec.clone()).unwrap_or_default();
        let had = calls::peers(ctx, &call).await?.into_iter().find(|p| p.name == op.name).map(|p| p.id);
        let set = AddArgs {
            name: Some(op.name.clone()),
            transport: Some(m.transport.clone()),
            address: Some(m.address.clone()),
            port: m.port.map(Value::from),
            ..AddArgs::default()
        };
        match (op.op == OpKind::Delete || !is_peer(&m), had) {
            (true, Some(id)) => calls::remove_peer(ctx, &call, id).await,
            (true, None) => Ok(()),
            (false, Some(id)) => calls::update_peer(ctx, &call, id, set).await,
            (false, None) => calls::add_peer(ctx, &call, set).await,
        }
    }
}

impl ResourceKind for MachineKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn describe(&self, op: &Op) -> Option<String> {
        let t = op.spec.get("transport").and_then(Value::as_str).unwrap_or_default();
        (op.op != OpKind::Delete && !matches!(t, "" | "this" | "local"))
            .then(|| format!("adds the machine {} ({t}): tasks may run there", op.name))
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.peer(op).await?;
            self.0.apply(call, op).await
        })
    }
}

pub fn register(s: &mut Setup) {
    let inner = Arc::new(StoredKind::new(
        KindInfo::new("machine", "machines", "wisp.machine", schema_of::<MachineSpec>()).order(8).sensitive(),
        s.ctx(),
    ));
    let k: Arc<dyn ResourceKind> = Arc::new(MachineKind(inner));
    s.contribute(&RESOURCE_KIND, k);
}
