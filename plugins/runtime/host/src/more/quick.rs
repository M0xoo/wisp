//! `quick` side runs outside any task.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;
use wisp_runtime_api::commands::{QUICK_CANCELLED, QuickArgs, QuickResult, RunPick};
use wisp_runtime_api::harness::HarnessRun;
use wisp_runtime_api::model::{Activity, Mode};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

const QUICK_TIMEOUT_MS: u64 = 120_000;
/// Cancels that came before their run started, kept this many at most (the oldest go first).
const EARLY_CANCELS: usize = 256;

/// The quick runs under way that their caller named (`QuickArgs::run_id`), and the cancels that reached a run before
/// it started (a goal dropped as its judge was being sent): that run is refused when it comes.
#[derive(Debug, Default)]
pub(crate) struct QuickRuns {
    inner: Mutex<Runs>,
}

#[derive(Debug, Default)]
struct Runs {
    live: HashMap<String, watch::Sender<bool>>,
    early: VecDeque<String>,
}

/// A named run's place in [`QuickRuns`]: gone with the run, however it ends.
pub(crate) struct Named<'a> {
    runs: &'a QuickRuns,
    id: String,
}

impl Drop for Named<'_> {
    fn drop(&mut self) {
        self.runs.lock().live.remove(&self.id);
    }
}

impl QuickRuns {
    fn lock(&self) -> std::sync::MutexGuard<'_, Runs> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `id`'s run starts: what stops it, or refused (cancelled already, or one under way has that id).
    pub(crate) fn begin(&self, id: &str) -> Result<(Named<'_>, watch::Receiver<bool>)> {
        let mut r = self.lock();
        if let Some(i) = r.early.iter().position(|x| x == id) {
            r.early.remove(i);
            return Err(RuntimeError::Cancelled(QUICK_CANCELLED.into()));
        }
        if r.live.contains_key(id) {
            return Err(RuntimeError::Conflict(format!("a quick run {id} is already under way")));
        }
        let (tx, rx) = watch::channel(false);
        r.live.insert(id.to_owned(), tx);
        Ok((Named { runs: self, id: id.to_owned() }, rx))
    }

    /// `runtime.quickCancel`: `true` when a run under way was told to stop; else it's refused if it starts later.
    pub(crate) fn cancel(&self, id: &str) -> bool {
        let mut r = self.lock();
        if let Some(tx) = r.live.remove(id) {
            tx.send_replace(true);
            return true;
        }
        if !r.early.iter().any(|x| x == id) {
            if r.early.len() >= EARLY_CANCELS {
                r.early.pop_front();
            }
            r.early.push_back(id.to_owned());
        }
        false
    }
}

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
        // named: `runtime.quickCancel` can stop it from here on (a cancel that came first refuses it now)
        let named = a.run_id.as_deref().filter(|x| !x.is_empty()).map(|id| self.quick_runs.begin(id)).transpose()?;
        let (_named, stop) = named.map_or((None, None), |(n, rx)| (Some(n), Some(rx)));
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
        let o = self.side_run(h.as_ref(), &run, Duration::from_millis(a.timeout_ms.unwrap_or(QUICK_TIMEOUT_MS)), stop).await?;
        if o.is_error {
            return Err(RuntimeError::Conflict(o.text));
        }
        let json = a.json.then(|| first_json(&o.text)).flatten();
        let activity = masked(o.activity);
        Ok(QuickResult { text: o.text, json, agent: h.info().id.clone(), model, cost_usd: o.cost_usd, activity })
    }

    /// `runtime.quickCancel`: the named quick run stops, its process tree killed; it answers `cancelled`.
    pub fn quick_cancel(&self, run_id: &str) -> bool {
        let stopped = self.quick_runs.cancel(run_id);
        tracing::debug!(run = %run_id, stopped, "runtime: quick run cancelled");
        stopped
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::super::sign_in::account_of;
    use super::*;
    use serde_json::json;

    /// A cancel that reaches a run before it starts refuses it when it does (a goal dropped as its judge was sent);
    /// one under way is told to stop; the run's id is free again once it ended.
    #[test]
    fn a_quick_cancel_stops_its_run_whenever_it_lands() {
        let runs = QuickRuns::default();
        assert!(!runs.cancel("early"), "nothing under way yet");
        assert!(matches!(runs.begin("early"), Err(RuntimeError::Cancelled(_))));
        assert!(runs.begin("early").is_ok(), "refused once, then a run of that id may start");
        let (named, rx) = runs.begin("r1").unwrap();
        assert!(matches!(runs.begin("r1"), Err(RuntimeError::Conflict(_))), "one run per id");
        assert!(runs.cancel("r1"));
        assert!(*rx.borrow(), "told to stop");
        drop(named);
        assert!(runs.lock().live.is_empty(), "its place goes with it");
        for i in 0..=EARLY_CANCELS {
            runs.cancel(&format!("x{i}"));
        }
        assert_eq!(runs.lock().early.len(), EARLY_CANCELS, "early cancels are bounded");
    }

    #[test]
    fn a_quick_answer_reads_its_json() {
        assert_eq!(first_json("Sure:\n{\"a\": 1}\nDone"), Some(json!({"a": 1})));
        assert_eq!(first_json("no json"), None);
        assert_eq!(account_of(Some("default")), "");
    }

    #[test]
    fn a_quick_runs_env_output_leaves_masked() {
        let read = Activity::ToolOutput { call_id: "c1".into(), text: "API_KEY=sk-live-123".into(), env: true, hide: Vec::new() };
        let other = Activity::ToolOutput { call_id: "c2".into(), text: "ok".into(), env: false, hide: Vec::new() };
        let out = masked(vec![read, other.clone()]);
        assert!(matches!(&out[0], Activity::ToolOutput { text, .. } if !text.contains("sk-live-123")), "{out:?}");
        assert_eq!(out[1], other);
    }

    #[test]
    fn a_quick_runs_thinking_and_tool_error_quoting_a_env_value_leave_masked() {
        use wisp_runtime_api::HarnessEvent;
        use wisp_runtime_api::model::ToolKind;
        use wisp_runtime_core::activity::{Effect, Head, apply};
        let mut h = Head::default();
        let evs = [
            HarnessEvent::Tool {
                kind: ToolKind::Read,
                label: "Read .env".into(),
                file: Some(".env".into()),
                detail: None,
                id: Some("c1".into()),
                output: None,
                title: None,
            },
            HarnessEvent::ToolOutput { id: "c1".into(), text: "API_KEY=sk-live-123".into() },
            HarnessEvent::Thinking { text: Some("so sk-live-123 is the key".into()) },
            HarnessEvent::ToolError { name: "Bash".into(), text: "denied: sk-live-123".into(), id: None },
        ];
        // as side_run collects them
        let steps: Vec<Activity> =
            evs.iter().filter_map(|e| if let Effect::Append(a) = apply(&mut h, e, true, &|_| false) { Some(a) } else { None }).collect();
        // alone (a step whose read fell outside MAX_STEPS) and with the read
        for batch in [steps[2..].to_vec(), steps.clone()] {
            let out = masked(batch);
            assert!(!format!("{out:?}").contains("sk-live-123"), "{out:?}");
        }
    }
}
