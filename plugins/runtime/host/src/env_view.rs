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
use wisp_runtime_core::{env_other, env_session, env_turn};

use crate::plugin::{Slot, rt};

/// Hide .env values (`git.maskEnvFiles`): on unless switched off.
pub(crate) fn on(ctx: &Ctx) -> bool {
    wisp_envmask::mask_on(ctx.setting(wisp_envmask::SETTING).as_ref())
}

/// The tasks whose stored reads are being read back (one read per task, however many rows go out meanwhile).
pub(crate) type Loading = std::sync::Mutex<std::collections::HashSet<String>>;

pub(crate) fn lock(m: &Loading) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct View(Ctx, Slot, Arc<Loading>);

/// What the turn row's task read (`session_id`), when it is in memory; when it isn't, it is read back in the
/// background, so the next send knows (this one hides a refused call stored before ranges existed whole: fail closed).
fn turn_known(slot: &Slot, loading: &Arc<Loading>, row: &Value) -> Option<Vec<String>> {
    known_of(slot, loading, row.get("session_id").and_then(Value::as_str)?)
}

/// [`turn_known`] of task `sid`.
pub(crate) fn known_of(slot: &Slot, loading: &Arc<Loading>, sid: &str) -> Option<Vec<String>> {
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

impl View {
    /// What the task of a batch of event rows read, when they are one task's: in memory, or read back for the next
    /// send when an answer text step stored before its ranges needs it (this one hides it whole: fail closed).
    fn events_known(&self, rows: &[&mut Value]) -> Option<Vec<String>> {
        let sid = rows.first()?.get("session_id").and_then(Value::as_str)?;
        if rows.iter().any(|r| r.get("session_id").and_then(Value::as_str) != Some(sid)) {
            return None;
        }
        if let Some(v) = rt(&self.1).ok()?.env.get(sid) {
            return Some(v.0);
        }
        if rows.iter().any(|r| env_mask::is_old_text(r)) { known_of(&self.1, &self.2, sid) } else { None }
    }
}

/// A task's watch (`watch`: its state, caption, title; `watch_page`: its HTML), by the task's id: what the agent put
/// there, free JSON (no key in it is a record's own state), so every string is masked against what the task read and
/// for .env-shaped lines; by the ranges kept with it (`body.envHide`, written with it) when that isn't in memory, else
/// hidden whole (fail closed, ADR-0054). The page's HTML is code (ADR-0055): only the task's values are masked in it,
/// never a line for its shape (`MAX=10;` in its script). The ranges never leave.
const WATCH_KINDS: [&str; 2] = ["watch", "watch_page"];

/// What of a watch row's `body` is code (its page's HTML).
fn code_of(kind: &str) -> &'static [&'static str] {
    if kind == "watch_page" { &["/html"] } else { &[] }
}

fn mask_watch(kind: &str, v: &mut Value, known: Option<&[String]>) -> bool {
    let Some(body) = v.get_mut("body") else { return false };
    let kept = body.as_object_mut().and_then(|b| b.remove(env_other::KEPT));
    env_other::mask_free(body, kept.as_ref(), known, code_of(kind)) | kept.is_some()
}

/// A watch row's kept ranges, taken out (Hide .env values off: nothing is masked, and they never leave either).
fn drop_kept(v: &mut Value) {
    if let Some(b) = v.get_mut("body").and_then(Value::as_object_mut) {
        b.remove(env_other::KEPT);
    }
}

impl RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &["turn", "event", "session", "watch", "watch_page"]
    }
    fn row(&self, kind: &str, v: &mut Value) {
        if !on(&self.0) {
            if WATCH_KINDS.contains(&kind) {
                drop_kept(v);
            }
            return;
        }
        if WATCH_KINDS.contains(&kind) {
            let known = v.get("id").and_then(Value::as_str).and_then(|id| known_of(&self.1, &self.2, id));
            mask_watch(kind, v, known.as_deref());
        } else if kind == "session" {
            let known = session_known(&self.1, &self.2, v);
            env_session::mask_row(v, known.as_deref());
        } else if kind == "turn" {
            // a row written with its ranges needs no read: what its task read in memory, if it is, masks the rest; one
            // whose ranges don't hold its other plugins' slots or prompt yet (before ADR-0054) reads them back
            let kept = v.pointer("/body/envHide").is_some_and(|h| {
                h.get(env_other::EXT).is_some()
                    || v.get("body")
                        .is_some_and(|b| !env_other::has_others(b) && b.get("prompt").is_none_or(|p| p.as_str().is_none_or(str::is_empty)))
            }) && !v.pointer("/body/envHide").is_some_and(Value::is_string);
            let known = if kept {
                let sid = v.get("session_id").and_then(Value::as_str);
                sid.and_then(|sid| rt(&self.1).ok()?.env.get(sid)).map(|x| x.0)
            } else {
                turn_known(&self.1, &self.2, v)
            };
            env_turn::mask_row(v, known.as_deref());
        } else {
            env_mask::mask_row_known(kind, v, None);
        }
    }
    fn rows(&self, kind: &str, rows: &mut [&mut Value]) {
        if !on(&self.0) {
            return;
        }
        if kind == "event" {
            let known = self.events_known(rows);
            env_mask::mask_event_rows_known(rows.iter_mut().map(|v| &mut **v), known.as_deref());
        } else {
            for v in rows.iter_mut() {
                self.row(kind, v);
            }
        }
    }
    fn patch(&self, kind: &str, path: &str, v: &mut Value) {
        if !on(&self.0) {
            return;
        }
        if kind == "turn" {
            env_turn::mask_patch(path, v, None);
        } else if WATCH_KINDS.contains(&kind) {
            // a patch that can't say whose watch it is: hidden (watches are upserted whole, so none is sent)
            env_other::mask_free(v, None, None, &[]);
        } else {
            env_mask::mask_patch(kind, path, v);
        }
    }
    fn patch_row(&self, kind: &str, id: &str, path: &str, v: &mut Value) {
        if kind == "turn" {
            if on(&self.0) {
                // the turn was written by this server (`note_turn`), its task's values read first: in memory
                let r = rt(&self.1).ok();
                let known = r.and_then(|r| r.env.task_of(id).and_then(|sid| r.env.get(&sid))).map(|v| v.0);
                env_turn::mask_patch(path, v, known.as_deref());
            }
            return;
        }
        if WATCH_KINDS.contains(&kind) {
            if !on(&self.0) {
                if path.is_empty() {
                    drop_kept(v);
                } else if path == "/body"
                    && let Some(b) = v.as_object_mut()
                {
                    b.remove(env_other::KEPT);
                }
                return;
            }
            let known = known_of(&self.1, &self.2, id);
            if path.is_empty() {
                mask_watch(kind, v, known.as_deref());
            } else {
                let kept = (path == "/body").then(|| v.as_object_mut().and_then(|b| b.remove(env_other::KEPT))).flatten();
                // the page's HTML, whole (`/body`) or by itself (`/body/html`): code
                let code: &[&str] = match path {
                    "/body" => code_of(kind),
                    "/body/html" if kind == "watch_page" => &[""],
                    _ => &[],
                };
                env_other::mask_free(v, kept.as_ref(), known.as_deref(), code);
            }
            return;
        }
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
    masked(t, |v| v.as_array_mut().into_iter().flatten().fold(false, |c, x| env_turn::mask_turn(x, known) | c))
}

/// Steps as one batch: an output finds its call.
pub(crate) fn mask_items(items: Vec<wisp_runtime_api::model::Step>) -> Masked<Vec<wisp_runtime_api::model::Step>> {
    mask_items_known(items, None)
}

/// [`mask_items`], `known` what their task read (an answer text masked against it too).
fn mask_items_known(items: Vec<wisp_runtime_api::model::Step>, known: Option<&[String]>) -> Masked<Vec<wisp_runtime_api::model::Step>> {
    masked(items, |v| env_mask::mask_steps_known(v.as_array_mut().into_iter().flatten(), known))
}

fn mask_page(p: c::ActivityPage, known: Option<&[String]>) -> Masked<c::ActivityPage> {
    Ok(c::ActivityPage { seq: p.seq, items: mask_items_known(p.items, known)? })
}

/// A turn's presentation: its prose against what its task read (`known`; `None`: hidden), then its .env blocks.
fn mask_presentation(
    p: Option<wisp_runtime_api::model::Presentation>,
    known: Option<&[String]>,
) -> Masked<Option<wisp_runtime_api::model::Presentation>> {
    masked(p, |v| {
        if v.is_null() {
            return false;
        }
        let prose = env_session::mask(v, &env_session::TURN, "/presentation", known);
        v.get_mut("blocks").is_some_and(|b| each(b, env_mask::mask_one_block)) | prose
    })
}

pub(crate) fn register(s: &mut Setup, slot: &Slot) {
    let loading: Arc<Loading> = Arc::default();
    s.contribute(&VIEWS, Arc::new(View(s.ctx(), slot.clone(), loading.clone())) as Arc<dyn RowView>);
    // other plugins' data about a task (ADR-0054)
    s.provide::<wisp_runtime_api::env::EnvMaskService>(
        Arc::new(crate::env_other::Other(s.ctx(), slot.clone(), loading)) as Arc<dyn wisp_runtime_api::env::EnvMask>
    );
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
            let r = rt(&slot)?;
            let p = r.activity(a.turn_id.as_str(), a.since_seq).await.map_err(WireError::from)?;
            if a.masked == Some(true) || on(&ctx) {
                let known = r.env_known(a.id.as_str()).await.ok().map(|v| v.0);
                mask_page(p, known.as_deref())
            } else {
                Ok(p)
            }
        }
    });
    let sl = slot.clone();
    s.command::<c::PresentationOf, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let p = r.presentation(a.id.as_str(), a.turn).await.map_err(WireError::from)?;
            if !on(&ctx) {
                return Ok(p);
            }
            let known = r.env_known(a.id.as_str()).await.ok().map(|v| v.0);
            mask_presentation(p, known.as_deref())
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
            Some(k) => *text = wisp_envmask::mask_spans(text, &wisp_envmask::raw_prose_spans(text, k)),
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

    #[tokio::test(flavor = "multi_thread")]
    async fn a_watch_and_its_page_quoting_a_value_the_task_read_leave_masked_live_and_after_a_restart_by_their_ranges() {
        use wisp_runtime_api::commands::{AgentWatchArgs, StartArgs};
        let slot = slot();
        let r = rt(&slot).unwrap();
        let dir = std::env::temp_dir().join(format!("wisp-envwatch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sid = r
            .create(StartArgs { prompt: "rotate".into(), cwd: Some(dir.display().to_string()), hold: true, ..StartArgs::default() })
            .await
            .unwrap()
            .id
            .0;
        r.env_known(&sid).await.unwrap();
        r.env_remember(&sid, &EnvValues(vec!["sk-live-one".into()]));
        let open = json!({ "action": "open", "title": "Key sk-live-one", "caption": "rotating sk-live-one",
                           "html": "<p data-k=\"sk-live-one\">old key</p>\n<script>\nconst MAX=10;\nX=1\n</script>",
                           "state": { "status": "sk-live-one", "file": "TOKEN=sk-live-three", "done": 1 } });
        let serde_json::Value::Object(body) = open else { unreachable!() };
        r.agent_watch(AgentWatchArgs { session: sid.clone(), body }).await.unwrap();
        let stored = |kind: &str| {
            let (k, id) = (kind.to_owned(), sid.clone());
            r.repo.store.read(move |rd| Ok(rd.get(&k, id.as_str())?.map(|row| Value::Object(row.into_iter().collect())))).unwrap().unwrap()
        };
        let (watch, page) = (stored("watch"), stored("watch_page"));
        assert!(watch.to_string().contains("sk-live-one"), "the store keeps it as the agent wrote it");
        assert!(watch["body"]["envHide"].get("/title").is_some(), "its ranges kept with it: {}", watch["body"]);
        let sent = |row: &Value, known: Option<&[String]>| {
            let mut v = row.clone();
            let kind = if row["body"].get("html").is_some() { "watch_page" } else { "watch" };
            mask_watch(kind, &mut v, known);
            v
        };
        let k = vec!["sk-live-one".to_owned()];
        for (what, v) in [("live", sent(&watch, Some(&k))), ("after a restart", sent(&watch, None))] {
            assert!(!v.to_string().contains("sk-live"), "{what}: {v}");
            assert_eq!(v["body"]["title"], "Key ••••", "{what}: masked, not hidden whole");
            assert_eq!(v["body"]["state"]["done"], 1);
            assert!(v["body"].get("envHide").is_none(), "{what}: the ranges never leave");
        }
        for (what, v) in [("live", sent(&page, Some(&k))), ("after a restart", sent(&page, None))] {
            let html = v["body"]["html"].as_str().unwrap();
            assert!(!html.contains("sk-live"), "{what}: {html}");
            assert!(html.contains("old key</p>") && html.contains("\nconst MAX=10;\nX=1\n"), "{what}: the page's script runs: {html}");
        }
        // a watch stored before its ranges (or unread), nothing known: hidden whole (fail closed)
        let mut old = watch.clone();
        old["body"].as_object_mut().unwrap().remove("envHide");
        let v = sent(&old, None);
        assert_eq!(v["body"]["title"], "••••");
        assert!(!v.to_string().contains("sk-live"));
    }
}
