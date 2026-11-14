//! wisp.learn's view of its own rows as they leave (ADR-0054, the `kernel.egress` point), on
//! `plugin:wisp.learn:lists`. A retro (`learn.retro`) is one task's: the retro agent ran in that task's folder, so
//! what it wrote (the items it added and removed, its error) goes through wisp.runtime's `runtime.envmask@1`, masked
//! against the .env values the task read; without the service it is hidden (fail closed). A list (`learn.list`) is
//! no one task's (retros merged into it, the user edits it): an item a retro in memory added is masked against that
//! retro's task, every other item has its .env-shaped lines masked, the one thing that can be told without a task
//! (as `crew_member.notebook` would be). The store keeps the rows as they are.

use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_kernel::egress::RowView;
use wisp_learn_api::Retro;
use wisp_runtime_api::env::{EnvMask, EnvMaskService, mask_or_hide};

use crate::{State, lock, store};

pub(crate) struct View(pub(crate) Ctx, pub(crate) Arc<State>);

/// A retro's body: what its agent wrote, against its task.
pub(crate) fn mask_retro(m: Option<&dyn EnvMask>, body: &mut Value) -> bool {
    let task = body.get("sessionId").and_then(Value::as_str).map(str::to_owned);
    let mut changed = false;
    for k in ["title", "error"] {
        if let Some(x) = body.get_mut(k).filter(|x| x.is_string()) {
            changed |= mask_or_hide(m, task.as_deref(), x, None);
        }
    }
    for k in ["added", "removed"] {
        for c in body.get_mut(k).and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(x) = c.get_mut("text") {
                changed |= mask_or_hide(m, task.as_deref(), x, None);
            }
        }
    }
    changed
}

/// A list's items: by the task of the retro that added each (`retros`, newest last), else their .env-shaped lines.
pub(crate) fn mask_list(m: Option<&dyn EnvMask>, retros: &[Retro], body: &mut Value) -> bool {
    let mut changed = false;
    for k in ["preferences", "lessons"] {
        for x in body.get_mut(k).and_then(Value::as_array_mut).into_iter().flatten() {
            let Some(t) = x.as_str() else { continue };
            let by = retros.iter().rev().find(|r| r.added.iter().any(|c| c.text == t)).map(|r| r.session_id.clone());
            changed |= match by {
                Some(task) => mask_or_hide(m, Some(&task), x, None),
                None => lines(x),
            };
        }
    }
    changed
}

fn lines(x: &mut Value) -> bool {
    let Value::String(t) = x else { return false };
    let spans = wisp_envmask::quote_spans(t, &[]);
    if spans.is_empty() {
        return false;
    }
    *t = wisp_envmask::mask_spans(t, &spans);
    true
}

/// `learn.view`'s answer as it leaves: its lists and retros masked as their rows are. An error, never the value as
/// it is, when the round trip fails (fail closed).
pub(crate) fn mask_view(m: Option<&dyn EnvMask>, view: wisp_learn_api::View) -> wisp_kernel::Result<wisp_learn_api::View> {
    let closed = |e: serde_json::Error| wisp_kernel::WireError::internal(format!("couldn't hide .env values: {e}"));
    let retros = view.history.clone();
    let mut v = serde_json::to_value(view).map_err(closed)?;
    if let Some(g) = v.get_mut("global") {
        mask_list(m, &retros, g);
    }
    for l in v.get_mut("projects").and_then(Value::as_object_mut).into_iter().flat_map(|o| o.values_mut()) {
        mask_list(m, &retros, l);
    }
    for r in v.get_mut("history").and_then(Value::as_array_mut).into_iter().flatten() {
        mask_retro(m, r);
    }
    serde_json::from_value(v).map_err(closed)
}

/// `x` (a command's answer: a retro, a list) through JSON, masked by `f`, back; an error, never the value as it is,
/// when the round trip fails (fail closed).
pub(crate) fn masked<T: serde::Serialize + serde::de::DeserializeOwned>(
    x: T,
    f: impl FnOnce(&mut Value) -> bool,
) -> wisp_kernel::Result<T> {
    let closed = |e: serde_json::Error| wisp_kernel::WireError::internal(format!("couldn't hide .env values: {e}"));
    let mut v = serde_json::to_value(x).map_err(closed)?;
    f(&mut v);
    serde_json::from_value(v).map_err(closed)
}

impl RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &[store::LIST.kind, store::RETRO.kind]
    }
    fn row(&self, kind: &str, v: &mut Value) {
        let m = self.0.use_service::<EnvMaskService>().ok();
        let Some(body) = v.get_mut("body") else { return };
        if kind == store::RETRO.kind {
            mask_retro(m.as_deref(), body);
        } else {
            let retros = lock(&self.1.data).history.clone();
            mask_list(m.as_deref(), &retros, body);
        }
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
    use wisp_learn_api::{Change, Kind};

    use super::*;

    /// What wisp.runtime's service does: task "s1" read `sk-live-one`; any other task isn't in memory.
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
                (_, v) => wisp_runtime_api::env::hide(v, &[]),
            }
        }
    }

    fn retro(sid: &str, text: &str) -> Retro {
        Retro {
            id: "r1".into(),
            session_id: sid.into(),
            title: "Rotate the key".into(),
            status: "learned".into(),
            added: vec![Change { text: text.into(), kind: Kind::Lessons, scope: "project".into() }],
            error: Some("the retro quoted sk-live-one".into()),
            ..Retro::default()
        }
    }

    #[test]
    fn a_retro_and_the_list_items_it_added_quoting_a_value_its_task_read_leave_masked_and_hidden_without_the_service() {
        // stored as the retro agent wrote it: the value is in the row (before this view, it left so)
        let r = retro("s1", "The API key is sk-live-one; keep it in .env");
        let mut body = serde_json::to_value(&r).unwrap();
        assert!(body.to_string().contains("sk-live-one"));
        assert!(mask_retro(Some(&Fake), &mut body));
        assert!(!body.to_string().contains("sk-live-one"), "{body}");
        assert_eq!(body["added"][0]["text"], "The API key is ••••; keep it in .env", "masked, not dropped");
        assert_eq!(body["added"][0]["scope"], "project", "its place is no text");
        assert_eq!(body["status"], "learned");
        // wisp.runtime off: the text goes (fail closed)
        let mut body = serde_json::to_value(&r).unwrap();
        assert!(mask_retro(None, &mut body));
        assert_eq!(body["added"][0]["text"], "••••");
        assert_eq!(body["title"], "••••");

        // the list: the item that retro added masked by its task; the user's own item keeps its words, but a .env line
        // in it goes; an item of a task not in memory: hidden until it is
        let mut list = json!({ "preferences": ["Use pnpm", "TOKEN=tok-abcdefgh"], "lessons": ["The API key is sk-live-one; keep it in .env", "x sk-live-one"] });
        let other = retro("s2", "x sk-live-one");
        assert!(mask_list(Some(&Fake), &[r.clone(), other], &mut list));
        assert!(!list.to_string().contains("sk-live-one"), "{list}");
        assert_eq!(list["lessons"][0], "The API key is ••••; keep it in .env");
        assert_eq!(list["lessons"][1], "••••");
        assert_eq!(list["preferences"][0], "Use pnpm");
        assert_eq!(list["preferences"][1], "TOKEN=••••");
        // nothing to hide: as it is
        let mut clean = json!({ "preferences": ["Use pnpm"], "lessons": [] });
        assert!(!mask_list(Some(&Fake), &[r], &mut clean));
    }
}
