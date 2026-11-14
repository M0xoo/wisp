//! .env values never leave the server (ADR-0050): wisp.runtime's `kernel.egress` view masks its `turn`, `event` and
//! `session` rows on the sync stream (the app, the CLI's attach, peers and boxes), and its read commands (`runtime.turns`,
//! `runtime.activity`, `runtime.presentation`, `runtime.get`, `runtime.list`, `wisp_session`, `wisp_sessions`) answer masked, so share bundles, MCP tools and the CLI
//! never carry one either. All of it unless Settings → Privacy → Hide .env values is off; a share masks even then.
//! `runtime.unmasked` (Reveal) answers one masked item as it is.

use std::sync::Arc;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use wisp_kernel::egress::{RowView, VIEWS};
use wisp_kernel::{Ctx, Setup, WireError};
use wisp_runtime_api::commands as c;
use wisp_runtime_core::env_mask::{self, Item};
use wisp_runtime_core::env_session;

use crate::plugin::{Slot, rt};

/// Hide .env values (`git.maskEnvFiles`): on unless switched off.
pub(crate) fn on(ctx: &Ctx) -> bool {
    wisp_envmask::mask_on(ctx.setting(wisp_envmask::SETTING).as_ref())
}

/// The tasks whose stored reads are being read back (one read per task, however many rows go out meanwhile).
type Loading = std::sync::Mutex<std::collections::HashSet<String>>;

fn lock(m: &Loading) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct View(Ctx, Slot, Arc<Loading>);

/// What the turn row's task read (`session_id`), when it is in memory; when it isn't, it is read back in the
/// background, so the next send knows (this one hides a refused call stored before ranges existed whole: fail closed).
fn turn_known(slot: &Slot, loading: &Arc<Loading>, row: &Value) -> Option<Vec<String>> {
    known_of(slot, loading, row.get("session_id").and_then(Value::as_str)?)
}

/// [`turn_known`] of task `sid`.
fn known_of(slot: &Slot, loading: &Arc<Loading>, sid: &str) -> Option<Vec<String>> {
    let r = rt(slot).ok()?;
    if let Some(v) = r.env.get(sid) {
        return Some(v.0);
    }
    if !lock(loading).insert(sid.to_owned()) {
        return None;
    }
    let (r2, sid, loading) = (r.clone(), sid.to_owned(), loading.clone());
    r.host.spawn(Box::pin(async move {
        let _ = r2.env_known(&sid).await;
        lock(&loading).remove(&sid);
    }));
    None
}

/// What a task's row (`id`) knows: its task's values when in memory. A row stored before ranges existed, with /btw
/// answers, has its task's reads read back for the next send (this one hides those answers whole); any other row's
/// kept ranges do without (no read per row of a list).
fn session_known(slot: &Slot, loading: &Arc<Loading>, row: &Value) -> Option<Vec<String>> {
    let id = row.get("id").and_then(Value::as_str)?;
    if let Some(v) = rt(slot).ok()?.env.get(id) {
        return Some(v.0);
    }
    let old = row.get("body").is_some_and(|b| !env_session::has_hide(b, &env_session::SESSION));
    let btw = row.pointer("/body/ext/wisp.runtime/btw").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    if old && btw { known_of(slot, loading, id) } else { None }
}

impl RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &["turn", "event", "session"]
    }
    fn row(&self, kind: &str, v: &mut Value) {
        if !on(&self.0) {
            return;
        }
        if kind == "session" {
            let known = session_known(&self.1, &self.2, v);
            env_session::mask_row(v, known.as_deref());
        } else {
            let known = if kind == "turn" { turn_known(&self.1, &self.2, v) } else { None };
            env_mask::mask_row_known(kind, v, known.as_deref());
        }
    }
    fn rows(&self, kind: &str, rows: &mut [&mut Value]) {
        if !on(&self.0) {
            return;
        }
        if kind == "event" {
            env_mask::mask_event_rows(rows.iter_mut().map(|v| &mut **v));
        } else {
            for v in rows.iter_mut() {
                self.row(kind, v);
            }
        }
    }
    fn patch(&self, kind: &str, path: &str, v: &mut Value) {
        if on(&self.0) {
            env_mask::mask_patch(kind, path, v);
        }
    }
    fn patch_row(&self, kind: &str, id: &str, path: &str, v: &mut Value) {
        if kind != "session" {
            return self.patch(kind, path, v);
        }
        if on(&self.0) {
            // the write that made this patch read the task's values first (`persist`): in memory, unless it failed
            let known = rt(&self.1).ok().and_then(|r| r.env.get(id)).map(|v| v.0);
            env_session::mask_patch(path, v, known.as_deref());
        }
    }
}

/// `x` as it leaves: through JSON, masked by `f`, back. Untouched when nothing in it was masked; an error, never the
/// value as it is, when the round trip fails (fail closed).
pub(crate) fn masked<T: Serialize + DeserializeOwned>(x: T, f: impl Fn(&mut Value) -> bool) -> Result<T, WireError> {
    let closed = |e: serde_json::Error| WireError::internal(format!("couldn't hide .env values: {e}"));
    let mut v = serde_json::to_value(&x).map_err(closed)?;
    if !f(&mut v) {
        return Ok(x);
    }
    serde_json::from_value(v).map_err(closed)
}

fn each(v: &mut Value, f: fn(&mut Value) -> bool) -> bool {
    v.as_array_mut().into_iter().flatten().fold(false, |c, x| f(x) | c)
}

type Masked<T> = Result<T, WireError>;

/// Turns of one task, `known` what its turns read (`Runtime::env_known`; `None` when that couldn't be read).
pub(crate) fn mask_turns(t: Vec<wisp_runtime_api::model::Turn>, known: Option<&[String]>) -> Masked<Vec<wisp_runtime_api::model::Turn>> {
    masked(t, |v| v.as_array_mut().into_iter().flatten().fold(false, |c, x| env_mask::mask_turn_known(x, known) | c))
}

/// Steps as one batch: an output finds its call.
pub(crate) fn mask_items(items: Vec<wisp_runtime_api::model::Step>) -> Masked<Vec<wisp_runtime_api::model::Step>> {
    masked(items, |v| env_mask::mask_steps(v.as_array_mut().into_iter().flatten()))
}

fn mask_page(p: c::ActivityPage) -> Masked<c::ActivityPage> {
    Ok(c::ActivityPage { seq: p.seq, items: mask_items(p.items)? })
}

fn mask_presentation(p: Option<wisp_runtime_api::model::Presentation>) -> Masked<Option<wisp_runtime_api::model::Presentation>> {
    masked(p, |v| v.get_mut("blocks").is_some_and(|b| each(b, env_mask::mask_one_block)))
}

pub(crate) fn register(s: &mut Setup, slot: &Slot) {
    s.contribute(&VIEWS, Arc::new(View(s.ctx(), slot.clone(), Arc::default())) as Arc<dyn RowView>);
    let sl = slot.clone();
    s.command::<c::Turns, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let t = r.turns(a.id.as_str(), a.before, a.limit).await.map_err(WireError::from)?;
            if a.masked == Some(true) || on(&ctx) {
                let known = r.env_known(a.id.as_str()).await.ok().map(|v| v.0);
                mask_turns(t, known.as_deref())
            } else {
                Ok(t)
            }
        }
    });
    let sl = slot.clone();
    s.command::<c::ActivityOf, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let p = rt(&slot)?.activity(a.turn_id.as_str(), a.since_seq).await.map_err(WireError::from)?;
            if a.masked == Some(true) || on(&ctx) { mask_page(p) } else { Ok(p) }
        }
    });
    let sl = slot.clone();
    s.command::<c::PresentationOf, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let p = rt(&slot)?.presentation(a.id.as_str(), a.turn).await.map_err(WireError::from)?;
            if on(&ctx) { mask_presentation(p) } else { Ok(p) }
        }
    });
    reads(s, slot);
    let sl = slot.clone();
    s.command::<c::Unmasked, _, _>(move |_ctx, _call, a| {
        let slot = sl.clone();
        async move { unmasked(&slot, a).await }
    });
}

/// `runtime.get`, `runtime.list` and `runtime.search`: what an agent wrote in a task's row masked (ADR-0050). Another plugin reads its
/// own slot as it wrote it (it may write it back), the title and runtime's slot masked whatever the setting says (a
/// share is built from them).
fn reads(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<c::Get, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let x = r.get(a.id.as_str()).await.map_err(WireError::from)?;
            let plugin = call.caller().plugin.is_some();
            if !plugin && !on(&ctx) {
                return Ok(x);
            }
            let known = r.env_known(a.id.as_str()).await.ok().map(|v| v.0);
            let part = if plugin { &env_session::SESSION_OWN } else { &env_session::SESSION };
            crate::env_row::mask_session(x, part, known.as_deref())
        }
    });
    let sl = slot.clone();
    s.command::<c::List, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let mask = on(&ctx) || call.caller().plugin.is_some();
            Ok(r.list(&a).iter().map(|x| crate::env_row::summary_out(&r, x, mask)).collect::<Vec<_>>())
        }
    });
    let sl = slot.clone();
    s.command::<c::Search, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let hits = r.search(&a.q, a.limit.unwrap_or(30).clamp(1, 100)).await.map_err(WireError::from)?;
            Ok(crate::env_row::search_out(&r, hits, on(&ctx) || call.caller().plugin.is_some()))
        }
    });
}

/// What `wisp_session` tells an agent: its answer's .env blocks masked, and every quote of a value the task read
/// (`known`; `None`: that couldn't be read, so nothing of it is told).
pub(crate) fn mask_agent_text(ctx: &Ctx, mut t: c::AgentText, known: Option<&[String]>) -> c::AgentText {
    if !on(ctx) {
        return t;
    }
    if let Some(text) = t.text.as_mut() {
        if let Some(m) = env_mask::mask_answer_text(text) {
            *text = m;
        }
        match known {
            Some(k) => *text = wisp_envmask::mask_spans(text, &wisp_envmask::value_spans(text, k)),
            None => "Couldn't hide this task's .env values, so it isn't shown. Open it in wisp.".clone_into(text),
        }
    }
    t
}

fn item_of(a: &c::UnmaskedArgs) -> Result<Item, WireError> {
    match (a.step, a.block, a.file.as_ref()) {
        (Some(s), None, None) => Ok(Item::Step(s)),
        (None, Some(b), None) => Ok(Item::Block(b as usize)),
        (None, None, Some(f)) => Ok(Item::Change(f.clone())),
        _ => Err(WireError::invalid("Name one thing to reveal: a step, a block or a file.")),
    }
}

/// `runtime.unmasked`: the one item as the store has it, when it is a masked one of this task's turn.
async fn unmasked(slot: &Slot, a: c::UnmaskedArgs) -> Result<Value, WireError> {
    let item = item_of(&a)?;
    let r = rt(slot)?;
    let gone = || WireError::not_found("Nothing hidden there to reveal.");
    let turn = r.repo.turn(a.turn_id.as_str()).await.map_err(|_| gone())?;
    if turn.session_id != a.id {
        return Err(gone()); // a turn of another task: the capability was checked against this one
    }
    let found = match item {
        Item::Step(seq) => {
            let page = r.activity(a.turn_id.as_str(), None).await.map_err(WireError::from)?;
            let steps: Vec<Value> = page.items.iter().filter_map(|s| serde_json::to_value(s).ok()).collect();
            env_mask::unmasked_step(&steps, seq)
        }
        other => env_mask::unmasked_of_turn(&serde_json::to_value(&turn).map_err(|e| WireError::internal(e.to_string()))?, &other),
    };
    found.ok_or_else(gone)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::{Arc, OnceLock};
    use std::time::Duration;

    use serde_json::json;
    use wisp_runtime_core::activity::EnvValues;
    use wisp_store::{Location, Store, SystemClock};

    use super::*;
    use crate::repo::Repo;
    use crate::runtime::Runtime;

    fn slot() -> Slot {
        let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
        crate::schema::install(&store).unwrap();
        let sim = wisp_proc::sim::SimProc::new();
        let r = Runtime::new(Repo::new(store), Arc::new(crate::host::Recorder::default()), Arc::new(sim), Arc::new(SystemClock));
        let slot: Slot = Arc::new(OnceLock::new());
        let _ = slot.set(r);
        slot
    }

    async fn loaded(slot: &Slot, loading: &Arc<Loading>, sid: &str) {
        for _ in 0..500 {
            if !lock(loading).contains(sid) && rt(slot).unwrap().env.get(sid).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("{sid}'s reads never came back");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_turn_row_finds_its_tasks_values_by_session_id_and_reads_them_back_once_when_not_in_memory() {
        let slot = slot();
        let r = rt(&slot).unwrap();
        r.env_known("s1").await.unwrap();
        r.env_remember("s1", &EnvValues(vec!["sk-live-one".into()]));
        let loading: Arc<Loading> = Arc::default();
        assert_eq!(turn_known(&slot, &loading, &json!({ "id": "t1", "session_id": "s1" })), Some(vec!["sk-live-one".to_owned()]));
        assert_eq!(turn_known(&slot, &loading, &json!({ "id": "t1" })), None, "no session_id: nothing to look up");
        assert!(lock(&loading).is_empty(), "and nothing read back");
        // a task not in memory: unknown now (fail closed), read back once, known on the next send
        let row = json!({ "id": "t2", "session_id": "s2" });
        assert_eq!(turn_known(&slot, &loading, &row), None);
        assert!(lock(&loading).contains("s2"));
        loaded(&slot, &loading, "s2").await;
        assert_eq!(turn_known(&slot, &loading, &row), Some(Vec::new()), "nothing stored: nothing read");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_row_reads_its_tasks_values_back_only_when_stored_before_ranges_with_btw_answers() {
        let slot = slot();
        let loading: Arc<Loading> = Arc::default();
        let kept = json!({ "id": "a", "body": { "envHide": {}, "ext": { "wisp.runtime": { "btw": [{ "answer": "x" }] } } } });
        assert_eq!(session_known(&slot, &loading, &kept), None);
        let no_btw = json!({ "id": "b", "body": { "ext": {} } });
        assert_eq!(session_known(&slot, &loading, &no_btw), None);
        assert!(lock(&loading).is_empty(), "a list of rows reads nothing back");
        let old = json!({ "id": "c", "body": { "ext": { "wisp.runtime": { "btw": [{ "answer": "x" }] } } } });
        assert_eq!(session_known(&slot, &loading, &old), None);
        assert!(lock(&loading).contains("c"));
        loaded(&slot, &loading, "c").await;
        assert_eq!(session_known(&slot, &loading, &old), Some(Vec::new()));
    }
}
