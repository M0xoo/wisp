//! `runtime.agents`: the harnesses as Settings → Agents shows them, each detected now.

use futures::future::join_all;
use wisp_runtime_api::commands::{AgentStatus, AgentsArgs};

use crate::runtime::Runtime;
use crate::sys::ProcSys;

impl Runtime {
    /// `runtime.agents` (v1 adapters/index.js `list`): every harness, detected now. All at once: each detect spawns
    /// its CLI a few times (`--version`, `models`, `--help`), and one after another the answer waited for the sum of
    /// every probe, not the slowest harness (`wisp_available`, `wisp_agents` and Settings → Agents all ask this).
    pub async fn agents(&self, _a: &AgentsArgs) -> Vec<AgentStatus> {
        let sys = ProcSys { proc: self.proc.clone() };
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let harnesses = self.host.harnesses();
        let found = join_all(harnesses.iter().map(|h| h.detect(&sys))).await;
        harnesses
            .iter()
            .zip(found)
            .map(|(h, found)| {
                let info = h.info().clone();
                if let Some(v) = &found.version {
                    crate::setup::note_version(&format!("harness:{}", info.id), v);
                }
                AgentStatus {
                    id: info.id,
                    name: info.name,
                    available: found.available,
                    setup: if found.available { None } else { h.setup(platform) },
                    version: found.version,
                    error: found.error,
                    models: found.models.unwrap_or(info.models),
                    efforts: found.efforts.unwrap_or(info.efforts),
                    delegates: info.ask_tool.is_some(),
                    signed_in: found.signed_in,
                }
            })
            .collect()
    }
}
