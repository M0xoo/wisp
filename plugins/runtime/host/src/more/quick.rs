//! `quick` side runs outside any task.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use wisp_runtime_api::commands::{QuickArgs, QuickResult, RunPick};
use wisp_runtime_api::harness::HarnessRun;
use wisp_runtime_api::model::{Activity, Mode};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

const QUICK_TIMEOUT_MS: u64 = 120_000;

fn first_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| serde_json::from_str::<Value>(&text[start..=end]).ok()).flatten().filter(Value::is_object)
}

/// A quick run's steps leave with .env values masked, always (ADR-0050): its caller keeps them (a goal check's page)
/// where no Reveal reaches.
fn masked(steps: Vec<Activity>) -> Vec<Activity> {
    let mut rows: Vec<Value> = steps.iter().filter_map(|s| serde_json::to_value(s).ok()).collect();
    if !wisp_runtime_core::env_mask::mask_steps(rows.iter_mut()) {
        return steps;
    }
    rows.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect()
}

impl Runtime {
    /// `runtime.quick` (v1 quick.js): one answer from a harness, outside any task.
    pub async fn quick(self: &Arc<Self>, a: QuickArgs) -> Result<QuickResult> {
        let pick = a.pick.unwrap_or(RunPick { agent: None, model: None, effort: None });
        let h = match pick.agent.as_deref().filter(|x| !x.is_empty()) {
            Some(id) => self.harness(id)?,
            None => self.host.harnesses().into_iter().next().ok_or_else(|| RuntimeError::NoHarness("any".into()))?,
        };
        // its folder as a turn's is (ADR-0053): one that's gone is refused, never answered from somewhere else
        let at = wisp_runtime_api::model::Session { cwd: a.cwd.clone(), ..wisp_runtime_api::model::Session::default() };
        self.folder_ready(&at, None).await.map_err(RuntimeError::Conflict)?;
        let model = pick.model.clone().unwrap_or_default();
        let run = HarnessRun {
            prompt: a.prompt,
            cwd: a.cwd,
            mode: Mode::Plan,
            model: model.clone(),
            effort: pick.effort.unwrap_or_default(),
            lean: true,
            quiet: self.lean_side(),
            ..HarnessRun::default()
        };
        let o = self.side_run(h.as_ref(), &run, Duration::from_millis(a.timeout_ms.unwrap_or(QUICK_TIMEOUT_MS))).await?;
        if o.is_error {
            return Err(RuntimeError::Conflict(o.text));
        }
        let json = a.json.then(|| first_json(&o.text)).flatten();
        let activity = masked(o.activity);
        Ok(QuickResult { text: o.text, json, agent: h.info().id.clone(), model, cost_usd: o.cost_usd, activity })
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

    #[test]
    fn a_quick_runs_env_output_leaves_masked() {
        let read = Activity::ToolOutput { call_id: "c1".into(), text: "API_KEY=sk-live-123".into(), env: true };
        let other = Activity::ToolOutput { call_id: "c2".into(), text: "ok".into(), env: false };
        let out = masked(vec![read, other.clone()]);
        assert!(matches!(&out[0], Activity::ToolOutput { text, .. } if !text.contains("sk-live-123")), "{out:?}");
        assert_eq!(out[1], other);
    }
}
