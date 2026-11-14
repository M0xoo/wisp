//! .env values in other plugins' data about a task (ADR-0054): what an agent wrote that another plugin keeps (a
//! goal judge's answer and why, a crew member's answer in a turn's `ext`, any plugin's slot on a turn) masked as it
//! leaves, against the values the task read and every .env-shaped line, like the task's own text (ADR-0050). With
//! those values unknown, all of its text is hidden (fail closed). wisp.runtime's own slot on a turn keeps its own
//! rules (`env_mask`: changes, refused calls).
//! Pure: no IO, no clock.

use serde_json::{Map, Value};

use crate::env_mask::{self, Known};
use crate::env_session::{self as es, Part};

/// wisp.runtime's own slot: masked by its own rules, never by the others'.
const OWN: &str = "wisp.runtime";

/// A key of a turn's ranges that says they hold the other plugins' slots too (rows written since ADR-0054): one
/// without it has its slots scanned, or hidden whole with nothing known.
pub const EXT: &str = "#ext";

/// Another plugin's data, whole: every string of it is an agent's (no ranges kept with it).
const OTHER: Part = Part { hide: "/#none", roots: &[""], legacy: None, prose: true };

/// The other plugins' slots on a turn (`Turn` JSON), with the turn's ranges.
const TURN_EXT: Part = Part { hide: "/envHide", roots: &["/ext"], legacy: None, prose: true };

/// [`TURN_EXT`] for a turn whose ranges were found before they held the slots: scanned, never their ranges alone.
const TURN_EXT_OLD: Part = Part { hide: "/#none", ..TURN_EXT };

/// A turn's prompt: the user's words mostly, but a plugin writes agent text there too (a goal's next round quotes
/// its judges). Only the values its task read are masked in it, never a line for its shape (`DEBUG=1` is the user's).
const PROMPT: Part = Part { hide: "/envHide", roots: &["/prompt"], legacy: None, prose: false };
const PROMPT_OLD: Part = Part { hide: "/#none", ..PROMPT };

/// Keys of a step that say how it pairs with others, not what anyone wrote: kept when its text is hidden whole.
const STEP_IDS: &[&str] = &["callId", "tool"];

/// Keys under another plugin's slot that hold what an agent wrote: hidden whole on a turn stored before its ranges
/// held the slots, while its task's values are unknown (the rest of the slot, a rating or an app's state, stays).
const AGENT_KEYS: &[&str] =
    &["answer", "text", "summary", "note", "reason", "why", "error", "question", "title", "body", "message", "output", "reply", "detail"];

fn masked_by(t: &mut String, spans: &[[u32; 2]]) -> bool {
    if spans.is_empty() {
        return false;
    }
    *t = wisp_envmask::mask_spans(t, spans);
    true
}

/// Another plugin's agent text about a task (`v`: a string or a subtree) masked as it leaves: steps under `activity`
/// by the .env step rules, a raw answer `text` as raw text (its .env blocks, values inside its JSON), a `prompt`
/// (wisp's words and the user's) against the values only, then every other string against `known` and every
/// .env-shaped line; all of its text hidden when `known` is `None` (how its steps pair kept).
pub fn mask_other(v: &mut Value, known: Known<'_>) -> bool {
    let esc = known.map(crate::env_turn::with_escaped);
    let k = esc.as_deref();
    let mut changed = false;
    if let Some(a) = v.get_mut("activity").and_then(Value::as_array_mut) {
        changed |= env_mask::mask_steps_known(a.iter_mut(), known);
    }
    if let Some(Value::String(t)) = v.get_mut("text") {
        if let Some(m) = env_mask::mask_answer_text(t) {
            *t = m;
            changed = true;
        }
        if let Some(k) = k {
            let spans = wisp_envmask::raw_prose_spans(t, k);
            changed |= masked_by(t, &spans);
        }
    }
    let Some(k) = k else {
        let ids: Vec<Vec<(&str, Value)>> =
            steps(v).map(|st| STEP_IDS.iter().filter_map(|i| Some((*i, st.get(*i)?.clone()))).collect()).collect();
        changed |= es::hide_whole(v, &OTHER);
        if let Some(a) = v.get_mut("activity").and_then(Value::as_array_mut) {
            for (st, kept) in a.iter_mut().zip(ids) {
                for (i, x) in kept {
                    st[i] = x;
                }
            }
        }
        return changed;
    };
    let prompt = v.as_object_mut().and_then(|o| o.remove("prompt"));
    changed |= es::mask(v, &OTHER, "", Some(k));
    if let Some(mut p) = prompt {
        if let Value::String(t) = &mut p {
            let spans = wisp_envmask::value_spans(t, k);
            changed |= masked_by(t, &spans);
        }
        v["prompt"] = p;
    }
    changed
}

fn steps(v: &Value) -> impl Iterator<Item = &Value> {
    v.get("activity").and_then(Value::as_array).into_iter().flatten()
}

/// A slot stored before its turn's ranges held it, nothing known: what an agent wrote hidden, .env-shaped lines in
/// the rest masked.
fn hide_agent(v: &mut Value, key: Option<&str>) -> bool {
    match v {
        Value::String(t) if key.is_some_and(|k| AGENT_KEYS.contains(&k)) => {
            if t.is_empty() || t == wisp_envmask::DOTS {
                return false;
            }
            wisp_envmask::DOTS.clone_into(t);
            true
        }
        Value::String(t) if t.contains('=') => {
            let spans = wisp_envmask::quote_spans(t, &[]);
            masked_by(t, &spans)
        }
        Value::Array(a) => a.iter_mut().fold(false, |c, x| hide_agent(x, key) | c),
        Value::Object(o) => o.iter_mut().fold(false, |c, (k, x)| hide_agent(x, Some(k)) | c),
        _ => false,
    }
}

fn others(ext: &Map<String, Value>) -> bool {
    ext.keys().any(|k| k != OWN)
}

/// Whether a turn (`Turn` JSON) has another plugin's slot.
#[must_use]
pub fn has_others(turn: &Value) -> bool {
    turn.get("ext").and_then(Value::as_object).is_some_and(others)
}

/// Where the other plugins' slots on a turn quote one of `known` or read like a .env line (pointer → ranges), and
/// [`EXT`]: added to the turn's ranges as it is written.
pub fn hide_of_others(turn: &Value, known: &[String], into: &mut Map<String, Value>) {
    into.insert(EXT.into(), Value::Array(Vec::new()));
    if !known.is_empty()
        && let Some(p) = turn.get("prompt").and_then(Value::as_str)
    {
        let spans = wisp_envmask::value_spans(p, known);
        if !spans.is_empty() {
            into.insert("/prompt".into(), serde_json::json!(spans));
        }
    }
    let Some(ext) = turn.get("ext").and_then(Value::as_object).filter(|e| others(e)) else { return };
    let mut slots = ext.clone();
    slots.remove(OWN);
    let m = es::hide_of(&serde_json::json!({ "ext": slots }), &TURN_EXT, known);
    into.extend(m.into_iter().filter(|(k, _)| k.starts_with('/')));
}

/// `f` on `v` with wisp.runtime's slot out of it (`ext`: where the slots are in `v`), then put back.
fn without_own(v: &mut Value, ext: &str, f: impl FnOnce(&mut Value) -> bool) -> bool {
    let own = v.pointer_mut(ext).and_then(Value::as_object_mut).and_then(|e| e.remove(OWN));
    let changed = f(v);
    if let Some(o) = own
        && let Some(e) = v.pointer_mut(ext).and_then(Value::as_object_mut)
    {
        e.insert(OWN.into(), o);
    }
    changed
}

/// The other plugins' slots of a turn (`Turn` JSON or a turn row's `body`) masked as it leaves: its ranges when they
/// hold the slots, else scanned against `known`; hidden whole when nothing can be told.
pub fn mask_turn_others(t: &mut Value, known: Known<'_>) -> bool {
    let hide = t.get(es::HIDE);
    let new = hide.and_then(Value::as_object).is_some_and(|h| h.contains_key(EXT));
    // written while its task's values couldn't be read: nothing of it can be told
    let unread = hide.is_some_and(Value::is_string);
    let prompt = match (new, known) {
        (true, _) => es::mask(t, &PROMPT, "", known),
        (false, Some(_)) => es::mask(t, &PROMPT_OLD, "", known),
        // kept before its ranges held it, its task's values unknown (the first send after a restart): hidden until
        // they are read back, like the rest of its text (fail closed)
        (false, None) => es::hide_whole(t, &PROMPT),
    };
    if !has_others(t) {
        return prompt;
    }
    prompt
        | without_own(t, "/ext", |t| match (new, known) {
            (true, _) => es::mask(t, &TURN_EXT, "", known),
            (false, None) if unread => es::hide_whole(t, &TURN_EXT),
            (false, None) => t.get_mut("ext").is_some_and(|e| hide_agent(e, None)),
            (false, Some(_)) => es::mask(t, &TURN_EXT_OLD, "", known),
        })
}

/// One patch op's value landing at `at` in a turn's body (`/ext`, `/ext/wisp.crew/answers/-`, …): another plugin's
/// slot masked against `known`, hidden whole when that's unknown (a patch carries no ranges).
pub fn mask_patch_others(at: &str, v: &mut Value, known: Known<'_>) -> bool {
    let own = format!("/ext/{OWN}");
    if at == own || at.starts_with(&format!("{own}/")) {
        return false;
    }
    if at == "/prompt" {
        return match known {
            Some(_) => es::mask(v, &PROMPT_OLD, "/prompt", known),
            None => es::hide_whole(v, &OTHER),
        };
    }
    if at == "/ext" {
        return without_own(v, "", |v| mask_other(v, known));
    }
    if at.starts_with("/ext/") {
        return mask_other(v, known);
    }
    false
}

/// Where another plugin keeps a record's ranges inside it (`v.envHide`): taken out before it is masked, never sent.
pub const KEPT: &str = "envHide";

/// Every string of `v` but its kept ranges ([`KEPT`]), with its pointer.
fn leaves(v: &Value, ptr: &mut String, top: bool, f: &mut impl FnMut(&str, &str)) {
    match v {
        Value::String(t) => f(ptr, t),
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                let n = ptr.len();
                let _ = std::fmt::Write::write_fmt(ptr, format_args!("/{i}"));
                leaves(x, ptr, false, f);
                ptr.truncate(n);
            }
        }
        Value::Object(o) => {
            for (k, x) in o.iter().filter(|(k, _)| !(top && k.as_str() == KEPT)) {
                let n = ptr.len();
                ptr.push('/');
                ptr.push_str(&k.replace('~', "~0").replace('/', "~1"));
                leaves(x, ptr, false, f);
                ptr.truncate(n);
            }
        }
        _ => {}
    }
}

fn leaves_mut(v: &mut Value, top: bool, f: &mut impl FnMut(&mut String) -> bool) -> bool {
    match v {
        Value::String(t) => f(t),
        Value::Array(a) => a.iter_mut().fold(false, |c, x| leaves_mut(x, false, f) | c),
        Value::Object(o) => o.iter_mut().filter(|(k, _)| !(top && k.as_str() == KEPT)).fold(false, |c, (_, x)| leaves_mut(x, false, f) | c),
        _ => false,
    }
}

/// Where `v` (another plugin's data about a task, as it is written) quotes one of `known`: pointer into `v` → byte
/// ranges, to keep with it, so a send before its task's values are back in memory (after a restart) masks it by them
/// ([`mask_other_kept`], [`mask_free`]) instead of hiding it whole. Values only: the .env-shaped lines and the .env
/// step rules need nothing known, so they run as it leaves.
#[must_use]
pub fn ranges_of(v: &Value, known: &[String]) -> Value {
    let k = crate::env_turn::with_escaped(known);
    let mut out = Map::new();
    leaves(v, &mut String::new(), true, &mut |p, t| {
        let spans = wisp_envmask::value_spans(t, &k);
        if !spans.is_empty() {
            out.insert(p.to_owned(), serde_json::json!(spans));
        }
    });
    Value::Object(out)
}

/// The ranges kept with a record ([`ranges_of`]) on `v`; an unreadable list is none (its text hidden: fail closed).
fn kept_spans(v: &mut Value, kept: Option<&Value>) -> Option<bool> {
    let m: std::collections::BTreeMap<String, Vec<[u32; 2]>> = serde_json::from_value(kept?.clone()).ok()?;
    let mut changed = false;
    for (p, spans) in m.into_iter().filter(|(_, s)| !s.is_empty()) {
        if let Some(Value::String(t)) = v.pointer_mut(&p) {
            *t = wisp_envmask::mask_spans(t, &spans);
            changed = true;
        }
    }
    Some(changed)
}

/// [`mask_other`], by the ranges kept with it when its task's values aren't in memory (`known` `None`): those, then
/// every rule that needs nothing known (.env-shaped lines, the .env step rules). No ranges: hidden whole.
pub fn mask_other_kept(v: &mut Value, kept: Option<&Value>, known: Known<'_>) -> bool {
    if known.is_some() {
        return mask_other(v, known);
    }
    match kept_spans(v, kept) {
        Some(c) => mask_other(v, Some(&[])) | c,
        None => mask_other(v, None),
    }
}

/// Data an agent wrote with no shape of its own (a watch's state and page, an app's JSON): every string of it masked
/// against `known` and for .env-shaped lines, whatever its key (no key is a record's state here). With `known` `None`:
/// by the ranges kept with it, else hidden whole (fail closed). Its kept ranges ([`KEPT`]) are left for the caller.
///
/// `code` names the subtrees of `v` (pointers, `""` for all of it) that are code, not prose (a page's HTML and its
/// script): only the values its task read are masked there (and their JSON-escaped forms), never a line for its shape,
/// so `MAX=10;` stays and the page still runs.
pub fn mask_free(v: &mut Value, kept: Option<&Value>, known: Known<'_>, code: &[&str]) -> bool {
    let esc = known.map(crate::env_turn::with_escaped);
    let ranged = if known.is_none() { kept_spans(v, kept) } else { Some(false) };
    let Some(ranged) = ranged else {
        return leaves_mut(v, true, &mut |t| {
            if t.is_empty() || t == wisp_envmask::DOTS {
                return false;
            }
            wisp_envmask::DOTS.clone_into(t);
            true
        });
    };
    let values = esc.as_deref().unwrap_or_default();
    let by_value = |t: &mut String| {
        let spans = wisp_envmask::value_spans(t, values);
        masked_by(t, &spans)
    };
    if code.contains(&"") {
        return ranged | leaves_mut(v, true, &mut |t| by_value(t));
    }
    // the code taken out while the rest is masked as prose, masked by its values, put back
    let mut taken: Vec<(&str, Value)> = code.iter().filter_map(|p| Some((*p, v.pointer_mut(p)?.take()))).collect();
    let mut changed = ranged
        | leaves_mut(v, true, &mut |t| {
            let spans = wisp_envmask::prose_spans(t, values);
            masked_by(t, &spans)
        });
    for (p, mut x) in taken.drain(..) {
        changed |= leaves_mut(&mut x, false, &mut |t| by_value(t));
        if let Some(slot) = v.pointer_mut(p) {
            *slot = x;
        }
    }
    changed
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;
    use wisp_envmask::DOTS;

    use super::*;

    fn known() -> Vec<String> {
        vec!["sk-live-one".into()]
    }

    fn judged() -> Value {
        json!({
            "id": "r1", "prompt": "Goal: x", "status": "done",
            "text": "NOT MET: the key sk-live-one is live\n```wisp\n{\"blocks\":[{\"type\":\"code\",\"file\":\".env\",\"code\":\"API_KEY=sk-live-two\"}]}\n```",
            "activity": [
                { "seq": 1, "kind": "tool", "tool": "Bash", "detail": "cat .env", "callId": "c1" },
                { "seq": 2, "kind": "tool_output", "callId": "c1", "text": "API_KEY=sk-other-9\nPORT=3000", "env": true }
            ]
        })
    }

    #[test]
    fn another_plugins_text_is_masked_against_the_tasks_values_and_hidden_whole_when_they_are_unknown() {
        let mut v = judged();
        assert!(mask_other(&mut v, Some(&known())));
        let s = v.to_string();
        assert!(!s.contains("sk-live-one") && !s.contains("sk-live-two") && !s.contains("sk-other-9"), "{s}");
        assert!(v["text"].as_str().unwrap().starts_with("NOT MET: the key •••• is live"), "masked, not dropped: {v}");
        assert_eq!(v["activity"][0]["detail"], "cat .env", "a command line with no value stays");
        assert_eq!(v["status"], "done");
        // a markdown block's .env line inside the raw answer's JSON, a PEM value escaped in it, the goal's prompt
        let pem = "-----BEGIN KEY-----\nPEMBODY123\n-----END KEY-----".to_owned();
        let blocks = json!({ "blocks": [{ "type": "markdown", "text": format!("see\nAPI_KEY=sk-md-77\nkey {pem}") }] });
        let mut raw = json!({ "prompt": "Goal: set DEBUG=1 and keep sk-live-one", "text": format!("NOT MET\n```wisp\n{blocks}\n```") });
        assert!(mask_other(&mut raw, Some(std::slice::from_ref(&pem))));
        let s = raw.to_string();
        assert!(!s.contains("sk-md-77") && !s.contains("PEMBODY123"), "{s}");
        assert_eq!(raw["prompt"], "Goal: set DEBUG=1 and keep sk-live-one", "a prompt: values only, and this one knows none of these");
        let mut raw = json!({ "prompt": "Goal: set DEBUG=1 and keep sk-live-one" });
        assert!(mask_other(&mut raw, Some(&known())));
        assert_eq!(raw["prompt"], "Goal: set DEBUG=1 and keep ••••");
        let mut why = json!("the key sk-live-one is live");
        assert!(mask_other(&mut why, Some(&known())));
        assert_eq!(why, "the key •••• is live");
        // nothing known: every text goes
        let mut v = judged();
        assert!(mask_other(&mut v, None));
        assert_eq!(v["text"], DOTS);
        assert_eq!(v["prompt"], DOTS);
        assert_eq!(v["status"], "done", "a state is not text");
        assert_eq!(v["activity"][1]["callId"], "c1", "how its steps pair stays");
        assert_eq!(v["activity"][0]["tool"], "Bash");
        let mut why = json!("anything");
        assert!(mask_other(&mut why, None));
        assert_eq!(why, DOTS);
        // nothing to hide: as it is, and masking twice changes nothing more
        let mut clean = json!({ "why": "the tests fail", "n": 3 });
        assert!(!mask_other(&mut clean, Some(&[])));
        let mut v = judged();
        mask_other(&mut v, Some(&known()));
        let once = v.clone();
        assert!(!mask_other(&mut v, Some(&known())) || v == once);
        assert_eq!(v, once);
    }

    fn turn() -> Value {
        json!({
            "id": "t1", "sessionId": "s1", "status": "done",
            "ext": {
                "wisp.crew": { "answers": [{ "question": "which key?", "answer": "use sk-live-one\nTOKEN=tok-abcdefgh" }] },
                "wisp.telemetry": { "feedback": { "rating": "up", "at": 5 } },
                "wisp.runtime": { "changes": [{ "file": "src/a.ts", "edits": [{ "before": "k = 'sk-live-one'", "after": "k = env()" }] }] }
            }
        })
    }

    #[test]
    fn a_turns_other_slots_are_masked_by_their_ranges_or_scanned_and_runtimes_own_slot_keeps_its_rules() {
        // written since ADR-0054: its ranges hold the slots, so it masks with nothing known
        let t = turn();
        let mut h = Map::new();
        h.insert(es::LINES.into(), json!([]));
        hide_of_others(&t, &known(), &mut h);
        assert!(h.contains_key("/ext/wisp.crew/answers/0/answer"), "{h:?}");
        assert!(!h.keys().any(|k| k.starts_with("/ext/wisp.runtime")), "runtime's slot is its own rules': {h:?}");
        let mut kept = t.clone();
        kept["envHide"] = Value::Object(h);
        assert!(mask_turn_others(&mut kept, None));
        assert_eq!(kept["ext"]["wisp.crew"]["answers"][0]["answer"], "use ••••\nTOKEN=••••");
        assert_eq!(kept["ext"]["wisp.crew"]["answers"][0]["question"], "which key?");
        assert_eq!(kept["ext"]["wisp.telemetry"]["feedback"]["rating"], "up");
        assert_eq!(kept["ext"]["wisp.runtime"], t["ext"]["wisp.runtime"], "untouched here, and put back");
        // stored before: scanned against what's known, hidden whole when nothing is
        let mut old = t.clone();
        assert!(mask_turn_others(&mut old, Some(&known())));
        assert_eq!(old["ext"]["wisp.crew"]["answers"][0]["answer"], "use ••••\nTOKEN=••••");
        let mut old = t.clone();
        assert!(mask_turn_others(&mut old, None));
        assert_eq!(old["ext"]["wisp.crew"]["answers"][0]["answer"], DOTS, "fail closed");
        assert_eq!(old["ext"]["wisp.telemetry"]["feedback"]["rating"], "up", "a rating is no agent text: it stays");
        // written while its values couldn't be read: all of it goes
        let mut unread = t.clone();
        unread["envHide"] = json!("unread");
        unread["prompt"] = json!("use sk-live-one");
        assert!(mask_turn_others(&mut unread, None));
        assert_eq!(unread["prompt"], DOTS);
        assert_eq!(unread["ext"]["wisp.telemetry"]["feedback"]["rating"], DOTS);
        // a turn with runtime's slot only: nothing to do, no scan
        let mut own = json!({ "ext": { "wisp.runtime": t["ext"]["wisp.runtime"].clone() } });
        assert!(!has_others(&own) && !mask_turn_others(&mut own, None));
    }

    #[test]
    fn a_prompt_a_plugin_wrote_from_agent_text_loses_the_tasks_values_and_keeps_the_users_own_lines() {
        let mut t = json!({ "id": "t2", "prompt": "The goal isn't met yet.\nclaude: the key sk-live-one is live\nDEBUG=1" });
        let mut h = Map::new();
        h.insert(es::LINES.into(), json!([]));
        hide_of_others(&t, &known(), &mut h);
        assert!(h.contains_key("/prompt"), "{h:?}");
        let mut kept = t.clone();
        kept["envHide"] = Value::Object(h);
        assert!(mask_turn_others(&mut kept, None), "its ranges mask it with nothing known");
        assert_eq!(kept["prompt"], "The goal isn't met yet.\nclaude: the key •••• is live\nDEBUG=1", "a line's shape is the user's");
        assert!(mask_turn_others(&mut t, Some(&known())), "stored before: scanned");
        assert_eq!(t["prompt"], kept["prompt"]);
        let mut p = json!("use sk-live-one");
        assert!(mask_patch_others("/prompt", &mut p, Some(&known())));
        assert_eq!(p, "use ••••");
        let mut p = json!("use sk-live-one");
        assert!(mask_patch_others("/prompt", &mut p, None), "a patch, nothing known: hidden");
        assert_eq!(p, DOTS);
    }

    #[test]
    fn a_turn_row_with_a_crew_answer_leaves_masked_and_a_clean_row_from_before_still_has_its_slots_looked_at() {
        use crate::env_turn;
        let body = turn();
        let row = |body: &Value| json!({ "id": "t1", "session_id": "s1", "prompt": body["prompt"].clone(), "answer": null, "body": body });
        // written now: its ranges hold the answer, so it leaves masked with nothing in memory (after a restart)
        let mut b = body.clone();
        b["envHide"] = env_turn::hide_of(&body, Some(&known()));
        let mut r = row(&b);
        assert!(env_turn::mask_row(&mut r, None));
        assert_eq!(r["body"]["ext"]["wisp.crew"]["answers"][0]["answer"], "use ••••\nTOKEN=••••");
        // a row said clean before ADR-0054 (no `#ext`), its crew answer quoting a value: looked at, not skipped
        let mut old = body.clone();
        old["envHide"] = json!({ "#lines": [], "#clean": [] });
        let mut r = row(&old);
        assert!(env_turn::mask_row(&mut r, Some(&known())));
        assert_eq!(r["body"]["ext"]["wisp.crew"]["answers"][0]["answer"], "use ••••\nTOKEN=••••");
        // a clean row written now leaves untouched (no scan)
        let plain =
            json!({ "id": "t3", "status": "done", "prompt": "hi", "ext": { "wisp.telemetry": { "feedback": { "rating": "up" } } } });
        let mut b = plain.clone();
        b["envHide"] = env_turn::hide_of(&plain, Some(&known()));
        assert!(b["envHide"].get("#clean").is_some(), "{b}");
        assert!(!env_turn::mask_row(&mut row(&b), Some(&known())));
    }

    #[test]
    fn a_patch_into_another_slot_masks_by_where_it_lands() {
        let mut v = json!({ "question": "q", "answer": "use sk-live-one" });
        assert!(mask_patch_others("/ext/wisp.crew/answers/-", &mut v, Some(&known())));
        assert_eq!(v["answer"], "use ••••");
        let mut v = json!("use sk-live-one");
        assert!(mask_patch_others("/ext/wisp.crew/answers/0/answer", &mut v, None));
        assert_eq!(v, DOTS, "no ranges in a patch, nothing known: hidden");
        let mut whole = turn()["ext"].clone();
        assert!(mask_patch_others("/ext", &mut whole, Some(&known())));
        assert_eq!(whole["wisp.crew"]["answers"][0]["answer"], "use ••••\nTOKEN=••••");
        assert_eq!(whole["wisp.runtime"], turn()["ext"]["wisp.runtime"], "runtime's slot as its own rules have it");
        let mut v = json!("k = 'sk-live-one'");
        assert!(!mask_patch_others("/ext/wisp.runtime/changes/0/edits/0/before", &mut v, None), "runtime's own rules");
        assert!(!mask_patch_others("/presentation/blocks/0", &mut json!("sk-live-one"), None), "not a slot");
    }

    #[test]
    fn a_prompt_stored_before_its_ranges_held_it_is_hidden_until_its_tasks_values_are_back() {
        use crate::env_turn;
        // a turn row from before ADR-0054 (`#clean`, no `#ext`), its prompt quoting a value: the first send after a
        // restart knows nothing yet, so it leaves hidden (it went as it was: fail open)
        let body = json!({ "id": "t1", "status": "done", "prompt": "Goal not met: claude says sk-live-one is live",
                           "envHide": { "#lines": [], "#clean": [] } });
        let mut r = json!({ "id": "t1", "session_id": "s1", "prompt": body["prompt"].clone(), "answer": null, "body": body });
        assert!(env_turn::mask_row(&mut r, None));
        assert_eq!(r["body"]["prompt"], DOTS);
        assert_eq!(r["prompt"], DOTS, "the column leaves as the body's prompt");
        // once they are back: masked, the rest of it kept
        let mut r2 = json!({ "id": "t1", "session_id": "s1", "prompt": body["prompt"].clone(), "answer": null, "body": body });
        assert!(env_turn::mask_row(&mut r2, Some(&known())));
        assert_eq!(r2["prompt"], "Goal not met: claude says •••• is live");
        // known to have read nothing: as it is (a user's own prompt, no scan)
        let mut r3 = json!({ "id": "t1", "session_id": "s1", "prompt": body["prompt"].clone(), "answer": null, "body": body });
        assert!(!env_turn::mask_row(&mut r3, Some(&[])));
        // and without `#clean` (no ranges at all)
        let mut t = json!({ "id": "t2", "prompt": "use sk-live-one" });
        assert!(mask_turn_others(&mut t, None));
        assert_eq!(t["prompt"], DOTS);
    }

    #[test]
    fn a_record_kept_with_its_ranges_masks_after_a_restart_and_free_agent_json_is_masked_whatever_its_keys() {
        // ranges found as it is written, values only; sent with nothing in memory: by them, plus the rules that need
        // nothing known (a .env line, an output of a call that read .env)
        let mut turn = judged();
        let kept = ranges_of(&turn, &known());
        assert!(kept.get("/text").is_some(), "{kept}");
        assert!(mask_other_kept(&mut turn, Some(&kept), None));
        let s = turn.to_string();
        assert!(!s.contains("sk-live-one") && !s.contains("sk-live-two") && !s.contains("sk-other-9"), "{s}");
        assert!(turn["text"].as_str().unwrap().starts_with("NOT MET: the key •••• is live"), "masked, not hidden whole: {turn}");
        assert_eq!(turn["prompt"], "Goal: x");
        let mut why = json!("the key sk-live-one is live");
        let kept = ranges_of(&why, &known());
        assert!(mask_other_kept(&mut why, Some(&kept), None));
        assert_eq!(why, "the key •••• is live");
        // no ranges, nothing known: hidden whole (as before); a broken range list too
        let mut rec = json!({ "why": "the key sk-live-one is live" });
        assert!(mask_other_kept(&mut rec, None, None));
        assert_eq!(rec["why"], DOTS);
        let mut rec = json!({ "why": "the key sk-live-one is live" });
        assert!(mask_other_kept(&mut rec, Some(&json!("garbage")), None));
        assert_eq!(rec["why"], DOTS);
        // known: scanned, the ranges not needed
        let mut rec = json!({ "why": "the key sk-live-one is live" });
        assert!(mask_other_kept(&mut rec, None, Some(&known())));
        assert_eq!(rec["why"], "the key •••• is live");

        // free JSON (a watch's state): keys a record would keep as state (`status`, `file`, `id`) are an agent's here
        let state = json!({ "status": "sk-live-one", "file": "API_KEY=sk-live-one", "rows": [{ "id": "k sk-live-one" }], "n": 3, "env": "DEBUG=1" });
        let mut v = state.clone();
        assert!(mask_free(&mut v, None, Some(&known()), &[]));
        assert!(!v.to_string().contains("sk-live"), "{v}");
        assert_eq!(v["env"], "DEBUG=••••", "a .env-shaped line in agent text");
        assert_eq!(v["n"], 3);
        let mut v = state.clone();
        assert!(mask_free(&mut v, None, None, &[]));
        assert_eq!(v["status"], DOTS, "nothing known, no ranges: hidden whole");
        assert_eq!(v["n"], 3);
        let mut v = state.clone();
        let kept = ranges_of(&state, &known());
        assert!(mask_free(&mut v, Some(&kept), None, &[]));
        assert!(!v.to_string().contains("sk-live"), "{v}");
        assert_eq!(v["rows"][0]["id"], "k ••••", "by its ranges after a restart, the rest kept");
        // html (code): a value in an attribute masked, a .env line in a <pre> too (free JSON beside it); masking twice
        // changes nothing more
        let mut page = json!({ "html": "<p data-k=\"sk-live-one\">x</p>\n<pre>\nAPI_KEY=sk-live-one\n</pre>", "envHide": {} });
        assert!(mask_free(&mut page, None, Some(&known()), &["/html"]));
        assert!(!page.to_string().contains("sk-live"), "{page}");
        let once = page.clone();
        mask_free(&mut page, None, Some(&known()), &["/html"]);
        assert_eq!(page, once);
        assert_eq!(page["envHide"], json!({}), "its ranges are the caller's");
    }

    /// Round 163's bug: a watch page's script (`MAX=10;`, `X=1`) went out as `MAX=••••;` and the page broke. In code (a
    /// page's HTML, its script) only the task's known values are masked, and their JSON-escaped forms; never a line for
    /// its shape. Prose beside it keeps the .env-line rule; nothing known and no ranges still hides it whole.
    #[test]
    fn a_pages_script_keeps_its_key_value_lines_and_loses_only_the_tasks_known_values() {
        let html =
            "<script>\nconst MAX=10;\nMAX=10;\nX=1\nconst key = \"sk-live-one\";\nconst cfg = {\"k\":\"line\\nsk-live-one\"};\n</script>";
        let k = vec!["sk-live-one".to_owned(), "line\nsk-live-one".to_owned()];
        let mut page = json!({ "html": html, "note": "X=1" });
        assert!(mask_free(&mut page, None, Some(&k), &["/html"]));
        let out = page["html"].as_str().unwrap();
        assert!(!out.contains("sk-live"), "{out}");
        for kept in ["const MAX=10;", "\nMAX=10;\n", "\nX=1\n", "const key = \"••••\";"] {
            assert!(out.contains(kept), "{kept:?} survives: {out}");
        }
        assert!(out.contains("{\"k\":\"••••\"}"), "a value JSON-escaped in the script: {out}");
        assert_eq!(page["note"], "X=••••", "prose beside it keeps the .env-line rule");
        // a page that is all code (a patch of `/body/html`); by its ranges after a restart; nothing known: hidden
        let mut whole = json!(html);
        assert!(mask_free(&mut whole, None, Some(&k), &[""]));
        assert!(whole.as_str().unwrap().contains("\nX=1\n") && !whole.to_string().contains("sk-live"));
        let kept = ranges_of(&json!({ "html": html }), &k);
        let mut page = json!({ "html": html });
        assert!(mask_free(&mut page, Some(&kept), None, &["/html"]));
        let out = page["html"].as_str().unwrap();
        assert!(!out.contains("sk-live") && out.contains("const MAX=10;\nMAX=10;\nX=1"), "{out}");
        let mut page = json!({ "html": html });
        assert!(mask_free(&mut page, None, None, &["/html"]));
        assert_eq!(page["html"], DOTS);
    }
}
