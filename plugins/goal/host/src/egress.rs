//! wisp.goal's view of its own `goal_run` rows as they leave (ADR-0054, the `kernel.egress` point): a judge's answer,
//! why and everything it did go through wisp.runtime's `runtime.envmask@1`, masked against the .env values its task
//! read, as the task's own text is (ADR-0050). The store keeps the record as it is. Without the service (wisp.runtime
//! off), the record's text is hidden (fail closed).

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_kernel::egress::RowView;
use wisp_runtime_api::env::{EnvMask, EnvMaskService};

use crate::runs::KIND;

/// A record's columns that hold what its judge wrote (`turn`: what it was asked, answered and did).
const TEXT: &[&str] = &["why", "turn"];

pub(crate) struct RunView(pub(crate) Ctx);

/// `v` hidden whole, wisp.runtime gone: its strings, a record's states kept (`status`, `id`).
fn hide(v: &mut Value) -> bool {
    match v {
        Value::String(s) if !s.is_empty() && s != wisp_envmask::DOTS => {
            wisp_envmask::DOTS.clone_into(s);
            true
        }
        Value::Array(a) => a.iter_mut().fold(false, |c, x| hide(x) | c),
        Value::Object(o) => {
            o.iter_mut().filter(|(k, _)| !matches!(k.as_str(), "id" | "status" | "kind")).fold(false, |c, (_, x)| hide(x) | c)
        }
        _ => false,
    }
}

impl RunView {
    fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
        match self.0.use_service::<EnvMaskService>() {
            Ok(m) => m.mask(task, v),
            Err(_) => hide(v),
        }
    }
}

/// A record's text masked by `m` (`None`: wisp.runtime gone, hidden): what [`RunView`] does with a whole row.
pub(crate) fn mask_row(m: Option<&dyn EnvMask>, v: &mut Value) -> bool {
    let task = v.get("task").and_then(Value::as_str).map(str::to_owned);
    let mut changed = false;
    for k in TEXT {
        if let Some(x) = v.get_mut(*k).filter(|x| !x.is_null()) {
            changed |= match m {
                Some(m) => m.mask(task.as_deref(), x),
                None => hide(x),
            };
        }
    }
    changed
}

impl RowView for RunView {
    fn kinds(&self) -> &'static [&'static str] {
        &[KIND]
    }
    fn row(&self, _kind: &str, v: &mut Value) {
        let m = self.0.use_service::<EnvMaskService>().ok();
        mask_row(m.as_deref(), v);
    }
    fn patch(&self, _kind: &str, path: &str, v: &mut Value) {
        // a patch names its row, not its task: any text in it is hidden (records are written whole, so none is sent)
        if path.is_empty() {
            return self.row(KIND, v);
        }
        if TEXT.iter().any(|k| path == format!("/{k}") || path.starts_with(&format!("/{k}/"))) {
            self.mask(None, v);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    /// What wisp.runtime's service does, here: a task's values masked, an unknown task's text hidden.
    struct Fake;
    impl EnvMask for Fake {
        fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
            match (task, v) {
                (Some("s1"), Value::String(s)) => {
                    let m = s.replace("sk-live-one", "••••");
                    let c = m != *s;
                    *s = m;
                    c
                }
                (Some("s1"), Value::Object(o)) => o.values_mut().fold(false, |c, x| Fake.mask(Some("s1"), x) | c),
                (_, v) => hide(v),
            }
        }
    }

    fn record(task: &str) -> Value {
        json!({ "id": "r1", "task": task, "turn_id": "t1", "round": 1, "name": "claude", "status": "done", "verdict": "not_yet",
                "why": "the key sk-live-one is live", "turn": { "id": "r1", "status": "done", "text": "NOT MET: sk-live-one" } })
    }

    #[test]
    fn a_check_records_why_and_answer_go_through_the_tasks_mask_and_are_hidden_without_it() {
        let mut v = record("s1");
        assert!(mask_row(Some(&Fake), &mut v));
        assert_eq!(v["why"], "the key •••• is live");
        assert_eq!(v["turn"]["text"], "NOT MET: ••••");
        assert_eq!(v["verdict"], "not_yet", "its vote is not text");
        assert_eq!(v["name"], "claude");
        // wisp.runtime off: nothing can be masked, so the text goes
        let mut v = record("s1");
        assert!(mask_row(None, &mut v));
        assert_eq!(v["why"], "••••");
        assert_eq!(v["turn"]["text"], "••••");
        assert_eq!(v["turn"]["status"], "done");
        // a running check (no why yet): as it is
        let mut v = json!({ "id": "r2", "task": "s1", "status": "running", "why": null, "turn": { "id": "r2", "status": "running", "activity": [] } });
        assert!(!mask_row(Some(&Fake), &mut v));
    }
}
