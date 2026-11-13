//! `runtime.agents`: the harnesses as Settings → Agents shows them, each detected now.

use wisp_runtime_api::commands::{AgentStatus, AgentsArgs};

use crate::runtime::Runtime;
use crate::sys::ProcSys;

impl Runtime {
    /// `runtime.agents` (v1 adapters/index.js `list`): every harness, detected now.
    pub async fn agents(&self, _a: &AgentsArgs) -> Vec<AgentStatus> {
        let sys = ProcSys { proc: self.proc.clone() };
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let mut out = Vec::new();
        for h in self.host.harnesses() {
            let info = h.info().clone();
            let found = h.detect(&sys).await;
            if let Some(v) = &found.version {
                crate::setup::note_version(&format!("harness:{}", info.id), v);
            }
            out.push(AgentStatus {
                id: info.id.clone(),
                name: info.name.clone(),
                available: found.available,
                version: found.version.clone(),
                error: found.error.clone(),
                models: found.models.clone().unwrap_or(info.models),
                efforts: found.efforts.clone().unwrap_or(info.efforts),
                delegates: info.ask_tool.is_some(),
                signed_in: found.signed_in,
                setup: if found.available { None } else { h.setup(platform) },
            });
        }
        out
    }
}
