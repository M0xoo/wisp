//! .env values in a task's own row (ADR-0050): what an agent wrote there (a forked /btw's answer, a title from its
//! answer, the list row's preview, live line and question, its tags, any plugin's slot text) masked as it leaves,
//! like its turns. The row is stored as it is, with where it quotes a value the task read (`envHide`: JSON pointer →
//! byte ranges, written with it), so a row sent before the task's values are back in memory (after a restart) still
//! masks; the values it knows mask the rest, and a line shaped like a .env line is masked in agent text always.
//! Pure: no IO, no clock.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::{Map, Value};
use wisp_envmask::{DOTS, is_env_file, mask_spans, prose_spans, quote_spans, value_spans};

use crate::env_mask::Known;

/// Where a part keeps its ranges (offsets only), and the key the walk never masks.
pub const HIDE: &str = "envHide";

/// A key of the ranges that says they hold the .env-shaped lines of its agent text too, not only the values its task
/// read: a part kept with it whose task has no values known is masked by them alone, its text never scanned.
pub const LINES: &str = "#lines";

/// A key of the ranges: `[[count, sum]]` of the values they were found with ([`fingerprint`]). A part whose task knows
/// the same values as it leaves is masked by its ranges alone; one that knows more is scanned for them.
pub const KNOWN: &str = "#known";

/// What a set of values was, in two numbers: how many, and the sum of each one's FNV-1a hash (so their order doesn't
/// count). Never the values: the ranges leave the server with the row.
#[must_use]
pub fn fingerprint(known: &[String]) -> [u32; 2] {
    let fnv = |v: &str| v.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
    [u32::try_from(known.len()).unwrap_or(u32::MAX), known.iter().fold(0_u32, |s, v| s.wrapping_add(fnv(v)))]
}

/// Whether ranges found with `at` (a [`KNOWN`] entry, absent: none) still cover what the task knows (`known`;
/// `None`: not in memory, so nothing more to look for).
fn fresh(at: Option<[u32; 2]>, known: Known<'_>) -> bool {
    match known {
        None | Some([]) => true,
        Some(k) => at == Some(fingerprint(k)),
    }
}

/// [`fresh`] of a part's kept ranges as JSON (its `envHide`).
#[must_use]
pub fn fresh_hide(hide: Option<&Value>, known: Known<'_>) -> bool {
    let Some(k) = known.filter(|k| !k.is_empty()) else { return true };
    let at = hide.and_then(|h| h.pointer("/#known/0")).and_then(Value::as_array);
    let n = |i: usize| at.and_then(|a| a.get(i)).and_then(Value::as_u64).and_then(|x| u32::try_from(x).ok());
    matches!((n(0), n(1)), (Some(a), Some(b)) if [a, b] == fingerprint(k))
}

/// Fields that hold no agent text (ids, folders, states): never masked.
const STRUCT: &[&str] =
    &["id", "parentId", "turnId", "sessionId", "cwd", "agent", "model", "effort", "mode", "state", "status", "account", "kind", "by", HIDE];

/// An answer block's fields that hold no agent text in a prose part (its kind, tone, file: the .env rules read it).
const BLOCK: &[&str] = &["type", "tone", "language", "change", "device", "masked", "v", "file", "path"];

/// The fields of a `code` or `diff` answer block about a .env file: masked whole by its own rules
/// (`env_mask::mask_one_block`, which flags it for Reveal), never by a part's.
const ENV_BLOCK: &[&str] = &["code", "before", "after", "diff"];

/// Fields an agent writes as prose: a .env-shaped line in them is masked even with no value known, and they are
/// hidden whole when what the task read can't be told (fail closed).
const AGENT: &[&str] = &["title", "preview", "live", "question", "options", "answer", "error", "summary", "text", "note", "reason"];

/// One part of a task's data that leaves the server: a `Session`'s JSON (a sync row's `body` and `title`) or a
/// `Summary`'s (its `summary`).
#[derive(Debug, Clone, Copy)]
pub struct Part {
    /// where its ranges are kept (a pointer into the part)
    pub hide: &'static str,
    /// the subtrees an agent's text may be in
    pub roots: &'static [&'static str],
    /// a subtree hidden whole when the part has no ranges and nothing is known: entries stored before ranges existed
    pub legacy: Option<&'static str>,
    /// every string of it is an agent's text (a turn's answer): its .env-shaped lines are masked whatever the key
    pub prose: bool,
}

/// A task (`Session` JSON). In a sync row its `title` is a column and the rest is `body`.
pub const SESSION: Part =
    Part { hide: "/envHide", roots: &["/title", "/ext", "/tags"], legacy: Some("/ext/wisp.runtime/btw"), prose: false };
/// A task as another plugin reads it: the title and runtime's own slot (a plugin's slot is its own, read back as it
/// wrote it).
pub const SESSION_OWN: Part = Part { roots: &["/title", "/ext/wisp.runtime"], ..SESSION };
/// A list row (`Summary` JSON).
pub const SUMMARY: Part = Part { hide: "/envHide", roots: &[""], legacy: None, prose: false };
/// A turn (`Turn` JSON, a turn row's `body`): its rendered blocks (hero, markdown, callouts…), the line a refusal card
/// quotes. Its raw answer text (`/text`, JSON inside) is `env_turn`'s.
pub const TURN: Part = Part { hide: "/envHide", roots: &["/presentation", "/refusal/line"], legacy: None, prose: true };

fn within(p: &str, root: &str) -> bool {
    root.is_empty() || p == root || (p.starts_with(root) && p[root.len()..].starts_with('/'))
}

/// `p` relative to `at`, when it is within it.
fn rel<'a>(p: &'a str, at: &str) -> Option<&'a str> {
    within(p, at).then(|| &p[at.len()..])
}

fn esc(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

/// The last field name of a pointer (`/summary/options/0` → `options`).
fn last_key(p: &str) -> Option<String> {
    p.split('/').skip(1).filter(|s| *s != "-" && s.parse::<usize>().is_err()).last().map(|s| s.replace("~1", "/").replace("~0", "~"))
}

fn is_agent(key: Option<&str>) -> bool {
    key.is_some_and(|k| AGENT.contains(&k))
}

/// Whether a string under `key` of `part` gets its .env-shaped lines masked: never code ([`CODE`]).
fn lines(part: &Part, key: Option<&str>) -> bool {
    key != Some(CODE) && (part.prose || is_agent(key))
}

/// The key the walk gives a code field ([`ENV_BLOCK`]) of a code block not about a .env file ([`code_block`]): only
/// the values its task read are masked there, never a line for its shape (`MAX=10;` in a script is no secret).
const CODE: &str = "#code";

/// Languages a code block about a .env file may be named by (no file given): its lines keep the .env-line rule.
const ENV_LANGS: &[&str] =
    &["", "env", "dotenv", "sh", "bash", "zsh", "shell", "console", "ini", "properties", "conf", "text", "txt", "plaintext"];

/// A `code` or `diff` block that is code and not about a .env file: a file that isn't one, or a language that isn't
/// one a .env file is shown in. A block naming neither keeps the .env-line rule (fail closed).
fn code_block(o: &Map<String, Value>) -> bool {
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    matches!(s("type"), Some("code" | "diff"))
        && match s("file").or_else(|| s("path")) {
            Some(f) => !is_env_file(f),
            None => s("language").or_else(|| s("lang")).is_some_and(|l| !ENV_LANGS.contains(&l.trim().to_ascii_lowercase().as_str())),
        }
}

/// The key a field `k` of an object is walked under (`code`: the object is a [`code_block`]).
fn key_of(k: &str, code: bool) -> &str {
    if code && ENV_BLOCK.contains(&k) { CODE } else { k }
}

/// An answer block about a .env file (`code` or `diff`): its text is its own rules'.
fn env_block(o: &Map<String, Value>) -> bool {
    matches!(o.get("type").and_then(Value::as_str), Some("code" | "diff"))
        && o.get("file").or_else(|| o.get("path")).and_then(Value::as_str).is_some_and(is_env_file)
}

/// Whether the walk skips `k` of an object of `part` (`env`: an answer block about a .env file, in a prose part).
fn skipped(k: &str, part: &Part, env: bool) -> bool {
    STRUCT.contains(&k) || (part.prose && BLOCK.contains(&k)) || (env && ENV_BLOCK.contains(&k))
}

fn walk(v: &Value, ptr: &mut String, key: Option<&str>, part: &Part, f: &mut impl FnMut(&str, Option<&str>, &str)) {
    match v {
        Value::String(t) => f(ptr, key, t),
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                let n = ptr.len();
                let _ = write!(ptr, "/{i}");
                walk(x, ptr, key, part, f);
                ptr.truncate(n);
            }
        }
        Value::Object(o) => {
            let env = part.prose && env_block(o);
            let code = part.prose && !env && code_block(o);
            for (k, x) in o {
                if skipped(k, part, env) {
                    continue;
                }
                let n = ptr.len();
                ptr.push('/');
                ptr.push_str(&esc(k));
                walk(x, ptr, Some(key_of(k, code)), part, f);
                ptr.truncate(n);
            }
        }
        _ => {}
    }
}

fn walk_mut(v: &mut Value, key: Option<&str>, part: &Part, f: &mut impl FnMut(Option<&str>, &mut String) -> bool) -> bool {
    match v {
        Value::String(t) => f(key, t),
        Value::Array(a) => a.iter_mut().fold(false, |c, x| walk_mut(x, key, part, f) | c),
        Value::Object(o) => {
            let env = part.prose && env_block(o);
            let code = part.prose && !env && code_block(o);
            o.iter_mut().filter(|(k, _)| !skipped(k, part, env)).fold(false, |c, (k, x)| walk_mut(x, Some(key_of(k, code)), part, f) | c)
        }
        _ => false,
    }
}

/// Where `part`'s text in `v` quotes one of `known` or reads like a .env line in agent text: pointer → byte ranges,
/// to keep with it, and [`LINES`]. [`quotes`] says whether any text does.
#[must_use]
pub fn hide_of(v: &Value, part: &Part, known: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(LINES.into(), Value::Array(Vec::new()));
    if !known.is_empty() {
        out.insert(KNOWN.into(), serde_json::json!([fingerprint(known)]));
    }
    for root in part.roots {
        let Some(x) = v.pointer(root) else { continue };
        let mut ptr = (*root).to_owned();
        let key = last_key(root);
        walk(x, &mut ptr, key.as_deref(), part, &mut |p, k, t| {
            let spans = if lines(part, k) {
                prose_spans(t, known)
            } else if known.is_empty() {
                return;
            } else {
                value_spans(t, known)
            };
            if !spans.is_empty() {
                out.insert(p.to_owned(), serde_json::json!(spans));
            }
        });
    }
    out
}

/// Whether ranges from [`hide_of`] hide anything (a pointer's; the rest say how they were found).
#[must_use]
pub fn quotes(hide: &Map<String, Value>) -> bool {
    hide.keys().any(|k| k.starts_with('/'))
}

/// One string as it leaves: the values known, then a .env-shaped line when it is agent text; whole when `whole`
/// (nothing can be told about it). No copy when nothing in it is masked (a list snapshot walks thousands).
fn mask_str(lines: bool, t: &mut String, values: &[String], whole: bool) -> bool {
    if whole {
        if t.is_empty() || t == DOTS {
            return false;
        }
        DOTS.clone_into(t);
        return true;
    }
    let mut changed = false;
    if !values.is_empty() {
        let spans = value_spans(t, values);
        if !spans.is_empty() {
            *t = mask_spans(t, &spans);
            changed = true;
        }
    }
    if lines && t.contains('=') {
        let spans = quote_spans(t, &[]);
        if !spans.is_empty() {
            *t = mask_spans(t, &spans);
            changed = true;
        }
    }
    changed
}

/// `v`, which sits at `at` inside `part` (`""`: the whole part), masked as it leaves: the ranges kept with it (when
/// `v` holds them; they go with it, offsets only, so a later patch into them still applies on a client), the values
/// `known`, .env-shaped lines in agent text. With nothing known, the text of a `v` that can't carry ranges (a patch
/// deep in the part) is hidden whole, and so are the `legacy` subtree's answers of a part stored before ranges existed
/// (fail closed). An unreadable range list hides all of its text.
pub fn mask(v: &mut Value, part: &Part, at: &str, known: Known<'_>) -> bool {
    mask_with(v, part, at, known, false)
}

/// [`mask`], every agent text of the part hidden whole: a read that couldn't tell what the task read (fail closed).
pub fn hide_whole(v: &mut Value, part: &Part) -> bool {
    mask_with(v, part, "", None, true)
}

fn mask_with(v: &mut Value, part: &Part, at: &str, known: Known<'_>, force: bool) -> bool {
    let mut changed = false;
    let hide_at = rel(part.hide, at);
    let mut kept = false;
    let mut whole = force;
    let mut complete = false;
    if let Some(h) = hide_at.and_then(|r| v.pointer(r)).cloned() {
        kept = true;
        match serde_json::from_value::<BTreeMap<String, Vec<[u32; 2]>>>(h) {
            Ok(m) => {
                complete = m.contains_key(LINES) && fresh(m.get(KNOWN).and_then(|k| k.first().copied()), known);
                for (p, spans) in m {
                    if !p.starts_with('/') || !part.roots.iter().any(|root| within(&p, root)) {
                        continue;
                    }
                    if let Some(Value::String(t)) = rel(&p, at).and_then(|r| v.pointer_mut(r))
                        && !spans.is_empty()
                    {
                        *t = mask_spans(t, &spans);
                        changed = true;
                    }
                }
            }
            Err(_) => whole = true,
        }
    }
    // kept with its .env-shaped lines, found with all the task knows: its ranges are all there is to hide (no scan)
    if complete && !whole {
        return changed;
    }
    // nothing known and no ranges to go by: a patch deep in the part, or a prose part stored before ranges existed
    if known.is_none() && (hide_at.is_none() || (part.prose && !kept)) {
        whole = true;
    }
    let values = known.unwrap_or_default();
    for root in part.roots {
        let (sub, key) = if within(at, root) {
            ("", last_key(at))
        } else if let Some(r) = rel(root, at) {
            (r, last_key(root))
        } else {
            continue;
        };
        if let Some(x) = v.pointer_mut(sub) {
            changed |= walk_mut(x, key.as_deref(), part, &mut |k, t| mask_str(lines(part, k), t, values, whole));
        }
    }
    if known.is_none()
        && !kept
        && let Some(l) = part.legacy.and_then(|l| rel(l, at))
        && let Some(x) = v.pointer_mut(l)
    {
        changed |= walk_mut(x, None, part, &mut |k, t| {
            if matches!(k, Some("answer" | "error")) && !t.is_empty() && t != DOTS {
                DOTS.clone_into(t);
                true
            } else {
                false
            }
        });
    }
    changed
}

/// Whether `part` of `v` (at its root) kept ranges: a part written since they existed.
#[must_use]
pub fn has_hide(v: &Value, part: &Part) -> bool {
    v.pointer(part.hide).is_some()
}

/// A `session` sync row (`title`, `body`, `summary` columns) masked as it leaves.
pub fn mask_row(row: &mut Value, known: Known<'_>) -> bool {
    let Some(o) = row.as_object_mut() else { return false };
    let hide = o.get("body").and_then(|b| b.get(HIDE));
    // ranges complete and found with all the task knows: they say everything (its list row's too)
    let complete = complete(hide) && fresh_hide(hide, known);
    // and they hide nothing, its list row has none of its own: as it is
    if complete && hide.and_then(Value::as_object).is_some_and(|m| !quotes(m)) && o.get("summary").is_none_or(|s| s.get(HIDE).is_none()) {
        return false;
    }
    let mut title = o.remove("title");
    let mut changed = false;
    if let Some(b) = o.get_mut("body").and_then(Value::as_object_mut) {
        // the title is a column: back in the task's JSON for a moment, so the ranges kept for it apply
        if let Some(t) = title.take() {
            b.insert("title".into(), t);
        }
        let mut body = Value::Object(std::mem::take(b));
        changed |= mask(&mut body, &SESSION, "", known);
        if let Value::Object(mut m) = body {
            title = m.remove("title");
            *b = m;
        }
    } else if let Some(t) = title.as_mut() {
        changed |= mask(t, &SESSION, "/title", known);
    }
    if let Some(t) = title {
        o.insert("title".into(), t);
    }
    // a list row written with its task's (complete) ranges keeps its own only when it quotes one: none, nothing to hide
    let bare = complete && o.get("summary").is_some_and(|s| s.get(HIDE).is_none());
    if bare {
        return changed;
    }
    o.get_mut("summary").is_some_and(|s| mask(s, &SUMMARY, "", known)) | changed
}

/// Whether a part's kept ranges (at `hide`) hold its .env-shaped lines too.
#[must_use]
pub fn complete(hide: Option<&Value>) -> bool {
    hide.and_then(Value::as_object).is_some_and(|m| m.contains_key(LINES))
}

/// One patch op's value on a `session` row, landing at `path`.
pub fn mask_patch(path: &str, v: &mut Value, known: Known<'_>) -> bool {
    if path.is_empty() {
        return mask_row(v, known);
    }
    if path == "/title" {
        return mask(v, &SESSION, "/title", known);
    }
    if let Some(r) = rel(path, "/body") {
        return mask(v, &SESSION, r, known);
    }
    if let Some(r) = rel(path, "/summary") {
        return mask(v, &SUMMARY, r, known);
    }
    false
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn known() -> Vec<String> {
        vec!["sk-live-one".into()]
    }

    fn session() -> Value {
        json!({
            "id": "s1", "title": "Use sk-live-one", "cwd": "/p", "tags": ["sk-live-one"],
            "ext": {
                "wisp.runtime": { "btw": [{ "id": "b1", "question": "why?", "answer": "The key is sk-live-one.\nAPI_KEY=sk-live-one", "pending": false }] },
                "wisp.goal": { "verdict": { "reason": "it printed sk-live-one" } }
            }
        })
    }

    #[test]
    fn a_rows_kept_ranges_mask_it_with_nothing_known_and_leave_with_it() {
        let s = session();
        let hide = hide_of(&s, &SESSION, &known());
        assert_eq!(hide.len(), 6, "title, tag, answer, a plugin's reason, that its lines are in and what it was found with: {hide:?}");
        let mut body = s.clone();
        body.as_object_mut().unwrap().insert(HIDE.into(), Value::Object(hide.clone()));
        let mut title = body.as_object_mut().unwrap().remove("title").unwrap();
        let mut row = json!({ "id": "s1", "title": title.take(), "body": body, "summary": { "title": "Use sk-live-one" } });
        let mut sum_hide = Map::new();
        sum_hide.insert("/title".into(), json!([[4, 15]]));
        row["summary"][HIDE] = Value::Object(sum_hide);
        assert!(mask_row(&mut row, None));
        let text = row.to_string();
        assert!(!text.contains("sk-live"), "{text}");
        assert!(text.contains(HIDE), "the ranges go with it (offsets only), so a patch into them applies: {text}");
        assert_eq!(row["title"], "Use ••••");
        assert_eq!(row["body"]["ext"]["wisp.runtime"]["btw"][0]["answer"], "The key is ••••.\nAPI_KEY=••••", "masked, not dropped");
        assert_eq!(row["body"]["ext"]["wisp.runtime"]["btw"][0]["question"], "why?");
        assert_eq!(row["body"]["cwd"], "/p");
    }

    #[test]
    fn a_row_stored_before_ranges_hides_its_btw_answers_whole_until_its_values_are_known() {
        let mut row = json!({ "id": "s1", "title": "t", "body": session(), "summary": { "preview": "API_KEY=abcdefgh" } });
        row["body"].as_object_mut().unwrap().remove("title");
        let mut r1 = row.clone();
        mask_row(&mut r1, None);
        assert_eq!(r1["body"]["ext"]["wisp.runtime"]["btw"][0]["answer"], DOTS, "fail closed");
        assert_eq!(r1["summary"]["preview"], "API_KEY=••••", "a .env line in agent text, nothing known");
        let mut r2 = row;
        mask_row(&mut r2, Some(&known()));
        assert_eq!(r2["body"]["ext"]["wisp.runtime"]["btw"][0]["answer"], "The key is ••••.\nAPI_KEY=••••");
        assert_eq!(r2["body"]["ext"]["wisp.goal"]["verdict"]["reason"], "it printed ••••");
    }

    #[test]
    fn a_patch_masks_by_where_it_lands_and_hides_agent_text_whole_when_nothing_is_known() {
        let mut v = json!([{ "id": "b1", "answer": "The key is sk-live-one.", "question": "q" }]);
        assert!(mask_patch("/body/ext/wisp.runtime/btw", &mut v, Some(&known())));
        assert_eq!(v[0]["answer"], "The key is ••••.");
        let mut v = json!("The key is sk-live-one.");
        assert!(mask_patch("/body/ext/wisp.runtime/btw/0/answer", &mut v, None));
        assert_eq!(v, DOTS, "fail closed");
        let mut v = json!("Running sk-live-one");
        assert!(mask_patch("/summary/live", &mut v, Some(&known())));
        assert_eq!(v, "Running ••••");
        let mut v = json!(7);
        assert!(!mask_patch("/rev", &mut v, None));
        let mut v = json!([[0, 4]]);
        assert!(!mask_patch("/body/envHide/~1title", &mut v, None), "a range is offsets: as it is");
        let mut v = json!("API_KEY=abcdefgh");
        assert!(mask_patch("/summary/options/-", &mut v, Some(&[])), "an appended option is agent text");
        assert_eq!(v, "API_KEY=••••");
        // the slot whole, with its ranges: they apply and stay on the server
        let mut slot = json!({ "btw": [{ "answer": "x sk-live-one" }] });
        let mut body = json!({ "ext": { "wisp.runtime": slot.clone() } });
        let h = hide_of(&body, &SESSION, &known());
        body[HIDE] = Value::Object(h);
        let mut whole_body = body.clone();
        assert!(mask_patch("/body", &mut whole_body, None));
        assert_eq!(whole_body["ext"]["wisp.runtime"]["btw"][0]["answer"], "x ••••");
        assert!(whole_body.get(HIDE).is_some(), "kept for the patches that follow");
        assert!(mask_patch("/body/ext/wisp.runtime", &mut slot, None), "no ranges reach it: hidden whole");
        assert_eq!(slot["btw"][0]["answer"], DOTS);
    }

    #[test]
    fn unreadable_ranges_hide_every_agent_text() {
        let mut body = session();
        body[HIDE] = json!("garbled");
        assert!(mask(&mut body, &SESSION, "", None));
        assert_eq!(body["title"], DOTS);
        assert_eq!(body["ext"]["wisp.runtime"]["btw"][0]["question"], DOTS);
        assert_eq!(body["tags"][0], DOTS, "nothing can be told: all its text");
        assert_eq!(body["cwd"], "/p", "not text");
    }

    #[test]
    fn another_plugins_read_masks_runtimes_own_parts_only() {
        let mut s = session();
        mask(&mut s, &SESSION_OWN, "", Some(&known()));
        assert_eq!(s["title"], "Use ••••");
        assert_eq!(s["ext"]["wisp.goal"]["verdict"]["reason"], "it printed sk-live-one", "its own slot as it wrote it");
    }

    /// Round 163's bug, in a turn's answer blocks: a code block about a script (`MAX=10;`, `X=1`) went out as
    /// `MAX=••••;`. A code or diff block not about a .env file (a file that isn't one, or a language a .env isn't shown
    /// in) loses only the task's values; one about a .env file keeps its own rules, one naming neither keeps the .env-line
    /// rule (fail closed), and a markdown block beside them is prose. Ranges kept at write agree.
    #[test]
    fn a_code_block_not_about_a_env_file_loses_only_the_tasks_values_and_prose_keeps_the_line_rule() {
        let code = "const MAX=10;\nMAX=10;\nX=1\nconst key = \"sk-live-one\";";
        let mut t = json!({ "presentation": { "blocks": [
            { "type": "code", "file": "src/app.js", "code": code },
            { "type": "code", "language": "ts", "code": code },
            { "type": "diff", "file": "src/app.js", "before": "MAX=9;", "after": "MAX=10;" },
            { "type": "code", "code": "X=1" },
            { "type": "code", "language": "bash", "code": "X=1" },
            { "type": "markdown", "text": "X=1" }
        ] } });
        let hide = hide_of(&t, &TURN, &known());
        assert!(mask(&mut t, &TURN, "", Some(&known())));
        let b = &t["presentation"]["blocks"];
        for i in [0, 1] {
            let out = b[i]["code"].as_str().unwrap();
            assert!(out.starts_with("const MAX=10;\nMAX=10;\nX=1\n") && out.ends_with("\"••••\";"), "{i}: {out}");
        }
        assert_eq!((b[2]["before"].as_str(), b[2]["after"].as_str()), (Some("MAX=9;"), Some("MAX=10;")));
        assert_eq!(b[3]["code"], "X=••••", "no file, no language: the .env-line rule (fail closed)");
        assert_eq!(b[4]["code"], "X=••••", "a shell snippet may be a .env file's");
        assert_eq!(b[5]["text"], "X=••••", "prose");
        for p in ["/presentation/blocks/0/code", "/presentation/blocks/2/after"] {
            assert!(hide.get(p).is_none_or(|s| s.as_array().is_some_and(|a| a.len() <= 1)), "{p}: values only: {hide:?}");
        }
        assert!(hide.get("/presentation/blocks/2/after").is_none(), "nothing of the task's in it: {hide:?}");
    }
}
