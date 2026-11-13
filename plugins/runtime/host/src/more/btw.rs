//! /btw: side questions answered on a copy of the conversation, kept on the task.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_runtime_api::commands::{BtwArgs, BtwEntry};
use wisp_runtime_api::harness::HarnessRun;
use wisp_runtime_api::model::Mode;

use super::with_slot;
use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

const BTW_TIMEOUT: Duration = Duration::from_secs(300);

impl Runtime {
    /// `runtime.btw`: a side question answered on a copy of the conversation, kept on the task.
    #[allow(clippy::many_single_char_names)]
    pub async fn btw(self: &Arc<Self>, a: BtwArgs) -> Result<BtwEntry> {
        if a.question.trim().is_empty() {
            return Err(RuntimeError::Invalid("Ask something first.".into()));
        }
        let s = self.repo.session(a.id.as_str()).await?;
        let h = self.harness(&s.agent)?;
        let entry = BtwEntry { id: wisp_kernel::ids::uuid7(), question: a.question.clone(), answer: String::new(), at: self.now(), pending: true, error: None };
        self.put_btw(a.id.as_str(), &entry).await?;
        let fork = h.info().fork && s.resume_id.is_some();
        let run = HarnessRun {
            session_id: s.id.0.clone(),
            prompt: a.question,
            attachments: a.attachments,
            cwd: s.cwd.clone(),
            dirs: s.dirs.clone(),
            resume_id: if fork { s.resume_id.clone() } else { None },
            fork,
            mode: Mode::Plan,
            model: s.model.clone(),
            effort: s.effort.clone(),
            gate: h.info().side_gate,
            quiet: self.lean_task(&s), // a /btw is yours: lean as the task is (v1 runner.js:889)
            ..HarnessRun::default()
        };
        let (rt, mut e) = (self.clone(), entry.clone());
        // owned by the plugin's scope: switching the runtime off ends the side run with it
        self.host.spawn(Box::pin(async move {
            match rt.side_run(h.as_ref(), &run, BTW_TIMEOUT).await {
                Ok(o) if !o.is_error => e.answer = o.text,
                Ok(o) => e.error = Some(o.text),
                Err(err) => e.error = Some(err.to_string()),
            }
            e.pending = false;
            let _ = rt.put_btw(&s.id.0, &e).await;
        }));
        Ok(entry)
    }

    async fn put_btw(self: &Arc<Self>, id: &str, e: &BtwEntry) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let v = serde_json::to_value(e).map_err(|x| RuntimeError::Invalid(x.to_string()))?;
        with_slot(&mut s.ext, |m| {
            if let Some(arr) = m.entry("btw").or_insert_with(|| json!([])).as_array_mut() {
                match arr.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(e.id.as_str())) {
                    Some(x) => *x = v,
                    None => arr.push(v),
                }
            }
        });
        self.persist(&mut s, Vec::new()).await.map(|_| ())
    }

    /// `runtime.btw.drop`
    pub async fn btw_drop(self: &Arc<Self>, id: &str, btw: &str) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        with_slot(&mut s.ext, |m| {
            if let Some(arr) = m.get_mut("btw").and_then(Value::as_array_mut) {
                arr.retain(|x| x.get("id").and_then(Value::as_str) != Some(btw));
            }
        });
        self.persist(&mut s, Vec::new()).await.map(|_| ())
    }
}
