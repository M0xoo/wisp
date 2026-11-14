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
use wisp_runtime_api::env::{EnvMask, EnvMaskService, carry, keep, kept_of, mask_or_hide, mask_prompt_kept, take_kept};

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

/// A row's text masked against its task's values (`m` `None`: hidden), by the ranges kept with it as it was written
/// (`body.envHide`) when they aren't in memory (a restart's first send). The ranges never leave.
pub(crate) fn mask_row(m: Option<&dyn EnvMask>, kind: &str, v: &mut Value) -> bool {
    let about = about(kind, v);
    let Some(body) = v.get_mut("body") else { return false };
    let kept = take_kept(body, "");
    let Some((task, texts)) = about else { return kept.is_some() };
    texts.iter().fold(kept.is_some(), |c, p| {
        body.pointer_mut(p).is_some_and(|x| mask_prompt_kept(m, Some(&task), x, kept_of(kept.as_ref(), p))) | c
    })
}

/// The texts of a row (as it is about to be stored) and its task: pointers into its `body`.
fn texts_of(kind: &str, row: &Value) -> Vec<(String, String)> {
    about(kind, row).map(|(task, ps)| ps.iter().map(|p| ((*p).to_owned(), task.clone())).collect()).unwrap_or_default()
}

/// Where a row's text quotes a value its task read, kept in its `body` as it is written (`envHide`), so a send before
/// the task's values are back in memory masks by them (ADR-0055). A text whose task isn't in memory now gets none.
pub(crate) fn keep_ranges(m: Option<&dyn EnvMask>, kind: &str, row: &mut Value) {
    let texts = texts_of(kind, row);
    if let Some(body) = row.get_mut("body") {
        keep(m, body, "", &texts);
    }
}

/// [`keep_ranges`]' gaps filled from the row it replaces (`old`), where a text is as it was.
pub(crate) fn carry_ranges(kind: &str, old: &Value, row: &mut Value) {
    let texts = texts_of(kind, row);
    if let (Some(o), Some(body)) = (old.get("body"), row.get_mut("body")) {
        carry(o, body, "", &texts);
    }
}

/// `x` (a command's answer: entries of a task, plans) as it leaves: each row's text masked as its sync row is
/// (`kind`'s, `id` and `session_id` as the row has them). An error, never the value as it is, when the round trip
/// fails (fail closed).
pub(crate) fn masked<T: serde::Serialize + serde::de::DeserializeOwned>(
    m: Option<&dyn EnvMask>,
    kind: &str,
    x: T,
) -> wisp_kernel::Result<T> {
    let closed = |e: serde_json::Error| wisp_kernel::WireError::internal(format!("couldn't hide .env values: {e}"));
    let mut v = serde_json::to_value(x).map_err(closed)?;
    let one = |b: &mut Value| {
        let mut row = serde_json::json!({ "id": b.get("id"), "session_id": b.get("sessionId"), "body": b.take() });
        mask_row(m, kind, &mut row);
        *b = row["body"].take();
    };
    match &mut v {
        Value::Array(a) => a.iter_mut().for_each(one),
        b => one(b),
    }
    serde_json::from_value(v).map_err(closed)
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

    /// ADR-0055: a follow-up and a plan keep where they quote a value as they are written, so the first send after a
    /// restart (nothing in memory) masks by them instead of hiding them whole; a rewrite while the task isn't in memory
    /// keeps the ranges a text had if it is as it was; the ranges never leave; `later.list` / `later.plans` (and their
    /// MCP tools) answer masked as the rows are.
    #[test]
    fn a_follow_up_and_a_plan_keep_their_ranges_at_write_and_their_list_answers_are_masked() {
        use wisp_runtime_api::testing::EnvFake;
        let live = EnvFake::default().with("s1", &["sk-live-one"]);
        let restarted = EnvFake::default();
        let entry = json!({ "id": "e1", "session_id": "s1", "at": 5,
                            "body": { "id": "e1", "sessionId": "s1", "at": 5, "text": "retry with sk-live-one\nDEBUG=1", "by": "agent", "setAt": 1 } });
        let mut stored = entry.clone();
        keep_ranges(Some(&live), ENTRY.kind, &mut stored);
        assert!(stored["body"]["envHide"]["/text"].is_object(), "{stored}");
        let mut sent = stored.clone();
        assert!(mask_row(Some(&restarted), ENTRY.kind, &mut sent));
        assert_eq!(sent["body"]["text"], "retry with ••••\nDEBUG=1", "by its ranges, not hidden whole");
        assert!(sent["body"].get("envHide").is_none(), "the ranges never leave");
        // no ranges kept (written before this): hidden whole
        let mut old = entry.clone();
        assert!(mask_row(Some(&restarted), ENTRY.kind, &mut old));
        assert_eq!(old["body"]["text"], "••••");
        // rewritten while s1 isn't in memory: the same text keeps its ranges, a changed one gets none
        let mut again = entry.clone();
        keep_ranges(Some(&restarted), ENTRY.kind, &mut again);
        carry_ranges(ENTRY.kind, &stored, &mut again);
        assert_eq!(again["body"]["envHide"], stored["body"]["envHide"]);
        let mut changed = entry.clone();
        changed["body"]["text"] = json!("now sk-live-one twice sk-live-one");
        keep_ranges(Some(&restarted), ENTRY.kind, &mut changed);
        carry_ranges(ENTRY.kind, &stored, &mut changed);
        assert!(changed["body"].get("envHide").is_none());

        let plan = json!({ "id": "p1", "body": { "id": "p1", "kind": "task", "setAt": 1, "title": "Check sk-live-one",
                           "body": { "prompt": "rotate sk-live-one" }, "from": { "id": "s1", "title": "Rotate" } } });
        let mut stored = plan.clone();
        keep_ranges(Some(&live), PLAN.kind, &mut stored);
        mask_row(Some(&restarted), PLAN.kind, &mut stored);
        assert!(!stored.to_string().contains("sk-live"), "{stored}");
        assert_eq!(stored["body"]["body"]["prompt"], "rotate ••••");

        // the list commands: entries and plans masked as their rows
        let entries = vec![entry["body"].clone()];
        let out: Vec<Value> = masked(Some(&live), ENTRY.kind, entries).unwrap();
        assert_eq!(out[0]["text"], "retry with ••••\nDEBUG=1");
        assert_eq!(out[0]["id"], "e1");
        let one: Value = masked(Some(&live), PLAN.kind, plan["body"].clone()).unwrap();
        assert!(!one.to_string().contains("sk-live"), "{one}");
        let none: Vec<Value> = masked(None, ENTRY.kind, vec![entry["body"].clone()]).unwrap();
        assert_eq!(none[0]["text"], "••••", "wisp.runtime off: hidden");
    }
}
