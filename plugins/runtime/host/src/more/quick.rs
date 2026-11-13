//! `quick` side runs outside any task, and the harnesses as Settings → Agents shows them.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use wisp_runtime_api::commands::{AgentStatus, AgentsArgs, QuickArgs, QuickResult, RunPick};
use wisp_runtime_api::harness::HarnessRun;
use wisp_runtime_api::model::Mode;

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;
use crate::sys::ProcSys;

const QUICK_TIMEOUT_MS: u64 = 120_000;

fn first_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| serde_json::from_str::<Value>(&text[start..=end]).ok()).flatten().filter(Value::is_object)
}

impl Runtime {
    /// `runtime.quick` (v1 quick.js): one answer from a harness, outside any task.
    pub async fn quick(self: &Arc<Self>, a: QuickArgs) -> Result<QuickResult> {
        let pick = a.pick.unwrap_or(RunPick { agent: None, model: None, effort: None });
        let h = match pick.agent.as_deref().filter(|x| !x.is_empty()) {
            Some(id) => self.harness(id)?,
            None => self.host.harnesses().into_iter().next().ok_or_else(|| RuntimeError::NoHarness("any".into()))?,
        };
        let model = pick.model.clone().unwrap_or_default();
        let run = HarnessRun { prompt: a.prompt, cwd: a.cwd, mode: Mode::Plan, model: model.clone(), effort: pick.effort.unwrap_or_default(), lean: true, quiet: self.lean_side(), ..HarnessRun::default() };
        let o = self.side_run(h.as_ref(), &run, Duration::from_millis(a.timeout_ms.unwrap_or(QUICK_TIMEOUT_MS))).await?;
        if o.is_error {
            return Err(RuntimeError::Conflict(o.text));
        }
        let json = a.json.then(|| first_json(&o.text)).flatten();
        Ok(QuickResult { text: o.text, json, agent: h.info().id.clone(), model, cost_usd: o.cost_usd, activity: Vec::new() })
    }

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

#[cfg(test)]
mod tests {
    use super::super::sign_in::account_of;
    use super::*;
    use serde_json::json;

    #[test]
    fn a_quick_answer_reads_its_json() {
        assert_eq!(first_json("Sure:\n{\"a\": 1}\nDone"), Some(json!({"a": 1})));
        assert_eq!(first_json("no json"), None);
        assert_eq!(account_of(Some("default")), "");
    }
}
