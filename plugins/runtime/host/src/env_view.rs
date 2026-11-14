//! .env values never leave the server (ADR-0050): wisp.runtime's `kernel.egress` view masks its `turn` and `event`
//! rows on the sync stream (the app, the CLI's attach, peers and boxes), and its read commands (`runtime.turns`,
//! `runtime.activity`, `runtime.presentation`, `wisp_session`) answer masked, so share bundles, MCP tools and the CLI
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

impl View {
    /// What the turn row's task read, when it is in memory; when it isn't, it is read back in the background, so
    /// the next send knows (this one hides a refused call stored before ranges existed whole: fail closed).
    fn known(&self, row: &Value) -> Option<Vec<String>> {
        let sid = row.get("session_id").and_then(Value::as_str)?;
        let r = rt(&self.1).ok()?;
        if let Some(v) = r.env.get(sid) {
            return Some(v.0);
        }
        if !lock(&self.2).insert(sid.to_owned()) {
            return None;
        }
        let (r2, sid, loading) = (r.clone(), sid.to_owned(), self.2.clone());
        r.host.spawn(Box::pin(async move {
            let _ = r2.env_known(&sid).await;
            lock(&loading).remove(&sid);
        }));
        None
    }
}

impl RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &["turn", "event"]
    }
    fn row(&self, kind: &str, v: &mut Value) {
        if on(&self.0) {
            let known = if kind == "turn" { self.known(v) } else { None };
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
}

/// `x` as it leaves: through JSON, masked by `f`, back. Untouched when nothing in it was masked; an error, never the
/// value as it is, when the round trip fails (fail closed).
fn masked<T: Serialize + DeserializeOwned>(x: T, f: impl Fn(&mut Value) -> bool) -> Result<T, WireError> {
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
    let sl = slot.clone();
    s.command::<c::Unmasked, _, _>(move |_ctx, _call, a| {
        let slot = sl.clone();
        async move { unmasked(&slot, a).await }
    });
}

/// What `wisp_session` tells an agent, its answer's .env blocks masked.
pub(crate) fn mask_agent_text(ctx: &Ctx, mut t: c::AgentText) -> c::AgentText {
    if on(ctx)
        && let Some(m) = t.text.as_deref().and_then(env_mask::mask_answer_text)
    {
        t.text = Some(m);
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
