//! wisp.later's view of its own rows as they leave (ADR-0054, the `kernel.egress` point), on
//! `plugin:wisp.later:later`. Each is a task's: an entry (`later_entry`, a follow-up an agent or the user queued on
//! a task), a plan a task made (`later_plan` with `from`), a task's reminder (`later_meta`, keyed by the task).
//! Their text goes through wisp.runtime's `runtime.envmask@1` as a prompt does: only the .env values that task read
//! are masked (a user's own `DEBUG=1` stays), all of it hidden when they can't be told or wisp.runtime is off (fail
//! closed). A plan with no task behind it (made in the composer) is the user's own: as it is. The store keeps the
//! rows as they are.

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_kernel::egress::RowView;
use wisp_runtime_api::env::{EnvMask, EnvMaskService, mask_or_hide, mask_prompt};

use crate::store::{ENTRY, META, PLAN};

pub(crate) struct View(pub(crate) Ctx);

/// The task a row is about, and the texts in its body to mask.
fn about(kind: &str, v: &Value) -> Option<(String, &'static [&'static str])> {
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    if kind == ENTRY.kind {
        Some((s("/session_id").or_else(|| s("/body/sessionId"))?, &["/text"]))
    } else if kind == PLAN.kind {
        Some((s("/body/from/id")?, &["/text", "/title", "/body/prompt"]))
    } else if kind == META.kind {
        Some((s("/id")?, &["/reminder/text"]))
    } else {
        None
    }
}

/// A row's text masked against its task's values (`m` `None`: hidden).
pub(crate) fn mask_row(m: Option<&dyn EnvMask>, kind: &str, v: &mut Value) -> bool {
    let Some((task, texts)) = about(kind, v) else { return false };
    let Some(body) = v.get_mut("body") else { return false };
    texts.iter().fold(false, |c, p| body.pointer_mut(p).is_some_and(|x| mask_prompt(m, Some(&task), x)) | c)
}

impl RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &[ENTRY.kind, PLAN.kind, META.kind]
    }
    fn row(&self, kind: &str, v: &mut Value) {
        let m = self.0.use_service::<EnvMaskService>().ok();
        mask_row(m.as_deref(), kind, v);
    }
    fn patch(&self, kind: &str, path: &str, v: &mut Value) {
        // rows are upserted whole, so none is sent; one that can't say whose it is: hidden
        if path.is_empty() {
            return self.row(kind, v);
        }
        let m = self.0.use_service::<EnvMaskService>().ok();
        mask_or_hide(m.as_deref(), None, v, None);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    /// What wisp.runtime's service does: task "s1" read `sk-live-one` (a prompt keeps its own lines); any other task
    /// isn't in memory.
    struct Fake;
    impl EnvMask for Fake {
        fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
            match (task, v.get_mut("prompt")) {
                (Some("s1"), Some(Value::String(s))) => {
                    let m = s.replace("sk-live-one", "••••");
                    let c = m != *s;
                    *s = m;
                    c
                }
                _ => wisp_runtime_api::env::hide(v, &[]),
            }
        }
    }

    #[test]
    fn a_follow_up_a_plan_and_a_reminder_quoting_a_value_their_task_read_leave_masked_and_the_users_own_plan_as_it_is() {
        let entry = json!({ "id": "e1", "session_id": "s1", "at": 5,
                            "body": { "id": "e1", "sessionId": "s1", "at": 5, "text": "retry with sk-live-one\nDEBUG=1", "by": "agent", "setAt": 1 } });
        // stored as written: the value is in the row (before this view, it left so)
        assert!(entry.to_string().contains("sk-live-one"));
        let mut v = entry.clone();
        assert!(mask_row(Some(&Fake), ENTRY.kind, &mut v));
        assert_eq!(v["body"]["text"], "retry with ••••\nDEBUG=1", "a prompt: its values, not the user's lines");
        assert_eq!(v["body"]["by"], "agent");
        let mut v = entry.clone();
        assert!(mask_row(None, ENTRY.kind, &mut v), "wisp.runtime off");
        assert_eq!(v["body"]["text"], "••••");
        let mut v = entry.clone();
        v["session_id"] = json!("s9");
        assert!(mask_row(Some(&Fake), ENTRY.kind, &mut v), "a task not in memory");
        assert_eq!(v["body"]["text"], "••••");

        let plan = json!({ "id": "p1", "body": { "id": "p1", "kind": "task", "setAt": 1, "title": "Check sk-live-one",
                           "body": { "prompt": "rotate sk-live-one" }, "from": { "id": "s1", "title": "Rotate" } } });
        let mut v = plan.clone();
        assert!(mask_row(Some(&Fake), PLAN.kind, &mut v));
        assert!(!v.to_string().contains("sk-live-one"), "{v}");
        assert_eq!(v["body"]["body"]["prompt"], "rotate ••••");
        // the user's own plan (no task made it): as it is
        let mut own = plan.clone();
        own["body"].as_object_mut().unwrap().remove("from");
        assert!(!mask_row(Some(&Fake), PLAN.kind, &mut own));

        let mut meta = json!({ "id": "s1", "body": { "chain": 0, "reminder": { "text": "the key sk-live-one expires", "at": 9, "setAt": 1, "by": "agent" } } });
        assert!(mask_row(Some(&Fake), META.kind, &mut meta));
        assert_eq!(meta["body"]["reminder"]["text"], "the key •••• expires");
    }
}
