//! `runtime.envmask@1` (ADR-0054): .env values in another plugin's own data about a task, hidden as it leaves the
//! server. wisp.runtime is the one that knows what each task's turns read (ADR-0050), so it provides this; a plugin
//! that keeps agent-written text about a task in its own kinds (wisp.goal's `goal_run`: a judge's answer and why)
//! passes that text through it in its own `kernel.egress` view. A built-in uses it as any plugin would (ADR-0003).
//! Additive (2026-11-14).

use serde_json::Value;
use wisp_kernel::Service;

/// How a plugin masks what an agent wrote about a task. Masking only takes away, so it needs no permission and no
/// call; it does no IO (a view calls it for every row that leaves).
pub trait EnvMask: Send + Sync + 'static {
    /// `v` (a string, or a subtree of a plugin's own row: an answer, a reason, a turn-like `{text, activity}`)
    /// as it leaves, unless Settings → Privacy → Hide .env values is off: steps under `activity` by the .env step
    /// rules, a raw answer text's .env blocks, then every string against the values task `task` read and every
    /// .env-shaped line. When what the task read isn't in memory, or `task` is `None` (a patch that can't say
    /// whose it is), every text in `v` is hidden (fail closed); the task's values are read back for the next send.
    /// True when it changed.
    fn mask(&self, task: Option<&str>, v: &mut Value) -> bool;

    /// Where `v` (what is about to be written about task `task`) quotes a value the task read: ranges to keep with
    /// it (offsets only), for [`mask_kept`](Self::mask_kept). `None` when what the task read isn't in memory (then
    /// nothing is kept, and a send with nothing known hides it whole). Additive (2026-11-14).
    fn ranges(&self, task: &str, v: &Value) -> Option<Value> {
        let _ = (task, v);
        None
    }

    /// [`mask`](Self::mask), by `kept` (from [`ranges`](Self::ranges) as `v` was written) when what the task read
    /// isn't in memory, a restart's first send: its kept ranges and every rule that needs no value (a .env-shaped
    /// line), instead of hiding it whole. Additive (2026-11-14).
    fn mask_kept(&self, task: Option<&str>, v: &mut Value, kept: Option<&Value>) -> bool {
        let _ = kept;
        self.mask(task, v)
    }
}

/// What a hidden text becomes (`wisp_envmask::DOTS`).
pub const HIDDEN: &str = "••••";

/// Where a plugin keeps a record's ranges in its JSON (`envHide`): read by its view, never sent.
pub const KEPT: &str = "envHide";

/// `v`'s text hidden whole (no service to mask it: wisp.runtime off), the strings under `keep` keys kept (a
/// record's id or state). True when it changed.
pub fn hide(v: &mut Value, keep: &[&str]) -> bool {
    match v {
        Value::String(s) if !s.is_empty() && s != HIDDEN => {
            HIDDEN.clone_into(s);
            true
        }
        Value::Array(a) => a.iter_mut().fold(false, |c, x| hide(x, keep) | c),
        Value::Object(o) => o.iter_mut().filter(|(k, _)| !keep.contains(&k.as_str())).fold(false, |c, (_, x)| hide(x, keep) | c),
        _ => false,
    }
}

/// `v` about task `task` as it leaves, `kept` its ranges: masked by `m`, hidden whole without it (fail closed). What
/// a plugin's `kernel.egress` view calls for each field an agent wrote.
pub fn mask_or_hide(m: Option<&dyn EnvMask>, task: Option<&str>, v: &mut Value, kept: Option<&Value>) -> bool {
    match m {
        Some(m) => m.mask_kept(task, v, kept),
        None => hide(v, &[]),
    }
}

/// The service contract, requested by contract (`runtime.envmask@^1`).
#[derive(Debug)]
pub struct EnvMaskService;

impl Service for EnvMaskService {
    const ID: &'static str = "runtime.envmask";
    const MAJOR: u32 = 1;
    type Api = dyn EnvMask;
}

/// [`mask_or_hide`] of a prompt-like text (a follow-up, a plan's prompt: the user's words mostly): only the values
/// its task read are masked in it, never a line for its shape (`DEBUG=1` is the user's); hidden whole when they
/// can't be told.
pub fn mask_prompt(m: Option<&dyn EnvMask>, task: Option<&str>, v: &mut Value) -> bool {
    mask_prompt_kept(m, task, v, None)
}

/// [`mask_prompt`], by `kept` (its [`EnvMask::ranges`] as it was written) when what the task read isn't in memory: a
/// restart's first send masks by them instead of hiding it whole. Additive (2026-11-14).
pub fn mask_prompt_kept(m: Option<&dyn EnvMask>, task: Option<&str>, v: &mut Value, kept: Option<&Value>) -> bool {
    if !v.is_string() {
        return false;
    }
    // the ranges were found on the text itself (`""`); here it is the wrapper's `prompt`
    let kept = kept.and_then(Value::as_object).map(|k| Value::Object(k.iter().map(|(p, s)| (format!("/prompt{p}"), s.clone())).collect()));
    let mut w = serde_json::json!({ "prompt": v.take() });
    let changed = mask_or_hide(m, task, &mut w, kept.as_ref());
    *v = w["prompt"].take();
    changed
}

/// Where the texts `texts` of `body` (each a pointer into it and the task it is about) quote a value their task read,
/// kept with it as it is written: in the object at `at` (a pointer into `body`, `""` for itself), under [`KEPT`], one
/// entry per text (pointer → its ranges). A text whose task's values aren't in memory now gets none (a send with
/// nothing known hides it whole, unless [`carry`] keeps the ranges it had). Additive (2026-11-14).
pub fn keep(m: Option<&dyn EnvMask>, body: &mut Value, at: &str, texts: &[(String, String)]) {
    let mut kept = serde_json::Map::new();
    for (p, task) in texts {
        if let (Some(m), Some(x)) = (m, body.pointer(p).filter(|x| !x.is_null()))
            && let Some(h) = m.ranges(task, x)
        {
            kept.insert(p.clone(), h);
        }
    }
    if let Some(Value::Object(o)) = body.pointer_mut(at) {
        if kept.is_empty() {
            o.remove(KEPT);
        } else {
            o.insert(KEPT.into(), Value::Object(kept));
        }
    }
}

/// `body`, about to replace `old` (both as stored, kept ranges at `at`): each text of `texts` that got no ranges now
/// ([`keep`] ran while its task's values weren't in memory, the first write after a restart) and is as `old` had it
/// keeps `old`'s. Additive (2026-11-14).
pub fn carry(old: &Value, body: &mut Value, at: &str, texts: &[(String, String)]) {
    let Some(was) = old.pointer(at).and_then(|o| o.get(KEPT)).and_then(Value::as_object) else { return };
    let same: Vec<(String, Value)> = texts
        .iter()
        .filter(|(p, _)| body.pointer(at).and_then(|o| o.get(KEPT)).and_then(|k| k.get(p)).is_none())
        .filter(|(p, _)| old.pointer(p).is_some() && old.pointer(p) == body.pointer(p))
        .filter_map(|(p, _)| Some((p.clone(), was.get(p)?.clone())))
        .collect();
    if same.is_empty() {
        return;
    }
    if let Some(Value::Object(o)) = body.pointer_mut(at)
        && let Value::Object(k) = o.entry(KEPT).or_insert_with(|| Value::Object(serde_json::Map::new()))
    {
        k.extend(same);
    }
}

/// The ranges [`keep`] kept in `v` (at `at`), taken out: they never leave. Taken whatever Hide .env values says.
pub fn take_kept(v: &mut Value, at: &str) -> Option<Value> {
    v.pointer_mut(at).and_then(Value::as_object_mut).and_then(|o| o.remove(KEPT))
}

/// The ranges kept for the text at `ptr` (from [`take_kept`]).
#[must_use]
pub fn kept_of<'a>(kept: Option<&'a Value>, ptr: &str) -> Option<&'a Value> {
    kept.and_then(|k| k.get(ptr))
}
