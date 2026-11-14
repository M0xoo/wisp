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
use wisp_runtime_api::env::{EnvMask, EnvMaskService, keep, kept_of, mask_or_hide, take_kept};

use crate::{State, lock, store};

pub(crate) struct View(pub(crate) Ctx, pub(crate) Arc<State>);

/// A retro's texts its agent wrote (pointers into its body), each with its task.
fn retro_texts(body: &Value) -> Vec<(String, String)> {
    let Some(task) = body.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
    let mut out: Vec<String> =
        ["/title", "/error"].iter().filter(|p| body.pointer(p).is_some_and(Value::is_string)).map(|p| (*p).to_owned()).collect();
    for k in ["added", "removed"] {
        let n = body.get(k).and_then(Value::as_array).map_or(0, Vec::len);
        out.extend((0..n).map(|i| format!("/{k}/{i}/text")));
    }
    out.into_iter().map(|p| (p, task.to_owned())).collect()
}

/// A retro's body: what its agent wrote, against its task; by the ranges kept with it as it was written when the task's
/// values aren't in memory (a restart's first send). The ranges never leave.
pub(crate) fn mask_retro(m: Option<&dyn EnvMask>, body: &mut Value) -> bool {
    let kept = take_kept(body, "");
    let task = body.get("sessionId").and_then(Value::as_str).map(str::to_owned);
    retro_texts(body).iter().fold(kept.is_some(), |c, (p, _)| {
        body.pointer_mut(p).is_some_and(|x| mask_or_hide(m, task.as_deref(), x, kept_of(kept.as_ref(), p))) | c
    })
}

/// Where a retro's text quotes a value its task read, kept in its body (`envHide`) as it is written (ADR-0055).
pub(crate) fn keep_retro(m: Option<&dyn EnvMask>, body: &mut Value) {
    let texts = retro_texts(body);
    keep(m, body, "", &texts);
}

/// The items of a list (pointers into its body) a retro in memory added (`retros`, newest last), each with that
/// retro's task.
fn list_texts(retros: &[Retro], body: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for k in ["preferences", "lessons"] {
        for (i, x) in body.get(k).and_then(Value::as_array).into_iter().flatten().enumerate() {
            let Some(t) = x.as_str() else { continue };
            if let Some(r) = retros.iter().rev().find(|r| r.added.iter().any(|c| c.text == t)) {
                out.push((format!("/{k}/{i}"), r.session_id.clone()));
            }
        }
    }
    out
}

/// Where a list's kept ranges say which task each item is about ([`keep_list`]): a list sent before the retro that
/// added an item is in the history (it is written while that retro runs) still masks the item against its task.
const BY: &str = "#by";

/// A list's items: by the task of the retro that added each (`retros`, newest last, else the task kept with the list's
/// ranges), else their .env-shaped lines; by the ranges kept with the list as it was written when that task's values
/// aren't in memory. The ranges never leave.
pub(crate) fn mask_list(m: Option<&dyn EnvMask>, retros: &[Retro], body: &mut Value) -> bool {
    let kept = take_kept(body, "");
    let mut by: std::collections::HashMap<String, String> = kept
        .as_ref()
        .and_then(|k| k.get(BY))
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(p, t)| Some((p.clone(), t.as_str()?.to_owned()))).collect())
        .unwrap_or_default();
    by.extend(list_texts(retros, body));
    let mut changed = kept.is_some();
    for k in ["preferences", "lessons"] {
        for (i, x) in body.get_mut(k).and_then(Value::as_array_mut).into_iter().flatten().enumerate() {
            let p = format!("/{k}/{i}");
            changed |= match by.get(&p) {
                Some(task) => mask_or_hide(m, Some(task), x, kept_of(kept.as_ref(), &p)),
                None => lines(x),
            };
        }
    }
    changed
}

/// Where a list's items a retro added quote a value its task read, kept in its body as it is written: the texts it
/// kept them for (an item whose task isn't in memory gets none; the store's write carries what the row had,
/// `wisp_runtime_api::env::carry`).
pub(crate) fn keep_list(m: Option<&dyn EnvMask>, retros: &[Retro], body: &mut Value) -> Vec<(String, String)> {
    let texts = list_texts(retros, body);
    keep(m, body, "", &texts);
    if !texts.is_empty()
        && let Some(o) = body.as_object_mut()
        && let Value::Object(k) = o.entry(wisp_runtime_api::env::KEPT).or_insert_with(|| Value::Object(serde_json::Map::new()))
    {
        k.insert(BY.into(), Value::Object(texts.iter().map(|(p, t)| (p.clone(), Value::String(t.clone()))).collect()));
    }
    texts
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

    /// ADR-0055: a retro and the list items it added keep where they quote a value as they are written, so the first
    /// snapshot after a restart masks by them instead of hiding them whole; an item the user wrote keeps the .env-line
    /// rule; a list rewritten while the task isn't in memory keeps an item's ranges where it is as it was; they never
    /// leave.
    #[test]
    fn a_retro_and_the_items_it_added_keep_their_ranges_at_write_and_mask_after_a_restart() {
        use wisp_runtime_api::testing::EnvFake;
        let (live, restarted) = (EnvFake::default().with("s1", &["sk-live-one"]), EnvFake::default());
        let r = retro("s1", "rotate sk-live-one monthly");
        let mut stored = serde_json::to_value(&r).unwrap();
        keep_retro(Some(&live), &mut stored);
        assert!(stored["envHide"]["/error"].is_object() && stored["envHide"]["/added/0/text"].is_object(), "{stored}");
        let mut sent = stored.clone();
        assert!(mask_retro(Some(&restarted), &mut sent));
        assert!(!sent.to_string().contains("sk-live"), "{sent}");
        assert_eq!(sent["added"][0]["text"], "rotate •••• monthly", "by its ranges, not hidden whole");
        assert_eq!(sent["title"], "Rotate the key");
        assert!(sent.get("envHide").is_none(), "the ranges never leave");

        let list = json!({ "preferences": ["API_KEY=abc123"], "lessons": ["rotate sk-live-one monthly"], "updatedAt": 1 });
        let mut body = list.clone();
        let texts = keep_list(Some(&live), std::slice::from_ref(&r), &mut body);
        assert_eq!(texts, vec![("/lessons/0".to_owned(), "s1".to_owned())], "the user's own item is no task's");
        let mut sent = body.clone();
        assert!(mask_list(Some(&restarted), std::slice::from_ref(&r), &mut sent));
        assert_eq!(sent["lessons"][0], "rotate •••• monthly");
        // sent while its retro still runs (not in the history yet): the task kept with the ranges says whose it is
        for m in [&live, &restarted] {
            let mut early = body.clone();
            assert!(mask_list(Some(m), &[], &mut early));
            assert_eq!(early["lessons"][0], "rotate •••• monthly", "{early}");
            assert!(early.get("envHide").is_none());
        }
        assert_eq!(sent["preferences"][0], "API_KEY=••••", "the user's item: its .env-shaped lines");
        assert!(sent.get("envHide").is_none());
        // rewritten after a restart (nothing in memory): the item where it was keeps its ranges
        let mut again = list.clone();
        let texts = keep_list(Some(&restarted), std::slice::from_ref(&r), &mut again);
        assert!(again["envHide"].get("/lessons/0").is_none());
        wisp_runtime_api::env::carry(&body, &mut again, "", &texts);
        assert_eq!(again["envHide"], body["envHide"]);
    }
}
