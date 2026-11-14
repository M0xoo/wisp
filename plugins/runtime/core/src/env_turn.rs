//! .env values in a turn's own prose (ADR-0050): what the agent wrote in its answer (the raw final text, the hero's
//! title and summary, markdown, callouts, steps, any block's text, the line a refusal card quotes) masked as it
//! leaves, on top of the .env rules for code and diff blocks about a .env file (`env_mask`). Like a task's row
//! (`env_session`), the turn row keeps where its prose quotes a value the task read or reads like a .env line
//! (`body.envHide`, offsets only, written with it), so a row sent before its task's values are back in memory (after
//! a restart) still masks, and one whose task read nothing is never scanned. A turn stored before ranges existed is
//! masked against its task's values; with those unknown its prose is hidden whole (fail closed).
//! Pure: no IO, no clock.

use std::borrow::Cow;

use serde_json::Value;
use wisp_envmask::{DOTS, mask_spans, raw_prose_spans};

use crate::env_mask::{self, Known};
use crate::env_session::{self as es, HIDE, TURN};

/// What the ranges say when the task's values couldn't be read: unreadable, so all of its prose is hidden.
const UNREAD: &str = "unread";

/// `known` and each value as a JSON string writes it (`"` → `\"`, a PEM key's line breaks → `\n`): the raw answer
/// text carries its wisp block as JSON. Borrowed when no value changes.
pub(crate) fn with_escaped(known: &[String]) -> Cow<'_, [String]> {
    let esc = |v: &String| serde_json::to_string(v).ok().map(|j| j[1..j.len() - 1].to_owned()).filter(|j| j != v);
    if !known.iter().any(|v| v.contains(['"', '\\', '\n', '\r', '\t'])) {
        return Cow::Borrowed(known);
    }
    let mut all = known.to_vec();
    all.extend(known.iter().filter_map(esc));
    Cow::Owned(all)
}

/// Where the raw answer text's ranges are kept.
const TEXT: &str = "/text";

/// A key of the ranges that says the turn, masked as it was written, showed nothing to hide: knowing no more than then
/// as it leaves, it leaves as it is (no scan, no rule run).
pub const CLEAN: &str = "#clean";

/// The ranges a turn row keeps (`body.envHide`): where its prose quotes one of `known` or reads like a .env line, and
/// `#lines`. `known` unread (`None`): unreadable ranges, so all of its prose is hidden until the next write.
#[must_use]
pub fn hide_of(turn: &Value, known: Option<&[String]>) -> Value {
    let Some(known) = known else { return Value::String(UNREAD.into()) };
    let k = with_escaped(known);
    let mut m = es::hide_of(turn, &TURN, &k);
    // the other plugins' slots (a crew member's answer…), ADR-0054
    crate::env_other::hide_of_others(turn, &k, &mut m);
    if let Some(t) = turn.get("text").and_then(Value::as_str) {
        let spans = raw_prose_spans(t, &k);
        if !spans.is_empty() {
            m.insert(TEXT.into(), serde_json::json!(spans));
        }
    }
    // nothing for its ranges or the .env rules to hide: said, so it leaves untouched
    if !es::quotes(&m) {
        let mut probe = turn.clone();
        if let Some(o) = probe.as_object_mut() {
            o.insert(HIDE.into(), Value::Object(m.clone()));
        }
        if !mask_turn(&mut probe, Some(known)) {
            m.insert(CLEAN.into(), Value::Array(Vec::new()));
        }
    }
    Value::Object(m)
}

/// What a turn's kept ranges say about its raw text.
enum Kept {
    /// none kept: a turn stored before ranges existed, or a patch that doesn't carry them
    None,
    /// they couldn't be read (or its values couldn't, when it was written): hide it all
    Unread,
    /// its ranges, and whether they say all there is (its .env-shaped lines in, found with all the task knows)
    Spans(Vec<[u32; 2]>, bool),
}

fn kept(t: &Value, known: Known<'_>) -> Kept {
    let Some(h) = t.get(HIDE) else { return Kept::None };
    match serde_json::from_value::<std::collections::BTreeMap<String, Vec<[u32; 2]>>>(h.clone()) {
        Ok(mut m) => Kept::Spans(m.remove(TEXT).unwrap_or_default(), m.contains_key(es::LINES) && es::fresh_hide(Some(h), known)),
        Err(_) => Kept::Unread,
    }
}

/// The raw answer text as it leaves: its kept ranges, then (unless those are complete and nothing is known) the values
/// `known` and .env-shaped lines, inside its JSON too; all of it when nothing can be told (fail closed).
fn mask_raw(text: &mut String, kept: &Kept, known: Option<&[String]>) -> bool {
    let whole = match kept {
        Kept::Unread => true,
        Kept::None => known.is_none(),
        Kept::Spans(..) => false,
    };
    if whole {
        if text.is_empty() || text == DOTS {
            return false;
        }
        DOTS.clone_into(text);
        return true;
    }
    let mut changed = false;
    if let Kept::Spans(spans, complete) = kept {
        if !spans.is_empty() {
            *text = mask_spans(text, spans);
            changed = true;
        }
        if *complete {
            return changed;
        }
    }
    let spans = raw_prose_spans(text, known.unwrap_or_default());
    if !spans.is_empty() {
        *text = mask_spans(text, &spans);
        changed = true;
    }
    changed
}

/// A turn (`Turn` JSON, or a turn row's `body`) masked in place as it leaves: its kept ranges, the values `known`
/// and .env-shaped lines in its prose (all of it hidden when nothing can be told), then the .env rules (`env_mask`).
pub fn mask_turn(t: &mut Value, known: Known<'_>) -> bool {
    // the values as its ranges were found with them (escaped forms too), so `#known` compares like with like
    let k = known.map(with_escaped);
    let kept = kept(t, k.as_deref());
    let mut changed = match t.get_mut("text") {
        Some(Value::String(x)) => mask_raw(x, &kept, k.as_deref()),
        _ => false,
    };
    changed |= es::mask(t, &TURN, "", k.as_deref());
    changed |= crate::env_other::mask_turn_others(t, k.as_deref());
    env_mask::mask_turn_known(t, known) | changed
}

/// A `turn` sync row (its `body` and `answer` columns) masked in place. The `answer` column is the body's `text`:
/// it leaves as that did.
pub fn mask_row(row: &mut Value, known: Known<'_>) -> bool {
    // the answer column is written with the body's text (`turn_row`): one the length of another isn't it
    let len = |v: Option<&Value>| v.and_then(Value::as_str).map(str::len);
    let clean = row.pointer("/body/envHide/#clean").is_some()
        && es::fresh_hide(row.pointer("/body/envHide"), known.map(with_escaped).as_deref())
        && len(row.get("answer")) == len(row.pointer("/body/text"))
        // clean said before its ranges held the other plugins' slots and its prompt (ADR-0054): those are looked at
        && (row.pointer(&format!("/body/envHide/{}", crate::env_other::EXT)).is_some()
            || row.get("body").is_none_or(|b| {
                let prompt = b.get("prompt").and_then(Value::as_str).is_some_and(|p| !p.is_empty());
                !crate::env_other::has_others(b) && (!prompt || known.is_none_or(<[String]>::is_empty))
            }));
    if clean {
        return false;
    }
    let text = row.pointer("/body/text").and_then(Value::as_str).map(str::to_owned);
    let prompt = row.pointer("/body/prompt").and_then(Value::as_str).map(str::to_owned);
    let mut changed = row.get_mut("body").is_some_and(|b| mask_turn(b, known));
    // the prompt column is the body's prompt (ADR-0054): it leaves as that did, or masked on its own
    if prompt.is_some() && row.get("prompt").and_then(Value::as_str) == prompt.as_deref() {
        let out = row.pointer("/body/prompt").cloned().unwrap_or(Value::Null);
        if row.get("prompt") != Some(&out) {
            row["prompt"] = out;
            changed = true;
        }
    } else if let Some(p) = row.get_mut("prompt") {
        changed |= crate::env_other::mask_patch_others("/prompt", p, known.map(with_escaped).as_deref());
    }
    let same = text.is_some() && row.get("answer").and_then(Value::as_str) == text.as_deref();
    if same {
        let out = row.pointer("/body/text").cloned().unwrap_or(Value::Null);
        if row.get("answer") != Some(&out) {
            row["answer"] = out;
            changed = true;
        }
    } else if let Some(a) = row.get_mut("answer") {
        changed |= mask_answer(a, known);
    }
    changed
}

/// A raw answer text with no ranges of its own (the `answer` column, a patch to the body's `text`).
fn mask_answer(a: &mut Value, known: Known<'_>) -> bool {
    let Value::String(x) = a else { return false };
    let k = known.map(with_escaped);
    let changed = mask_raw(x, &Kept::None, k.as_deref());
    env_mask::mask_patch("turn", "/answer", a) | changed
}

/// One patch op's value on a `turn` row, landing at `path`; `known`: what the row's task read, when it is in memory.
pub fn mask_patch(path: &str, v: &mut Value, known: Known<'_>) -> bool {
    match path {
        "" => return mask_row(v, known),
        "/body" => return mask_turn(v, known),
        "/answer" | "/body/text" => return mask_answer(v, known),
        "/prompt" => return crate::env_other::mask_patch_others("/prompt", v, known.map(with_escaped).as_deref()),
        _ => {}
    }
    let k = known.map(with_escaped);
    let at = path.strip_prefix("/body").filter(|r| r.starts_with('/'));
    let changed = at.is_some_and(|at| es::mask(v, &TURN, at, k.as_deref()) | crate::env_other::mask_patch_others(at, v, k.as_deref()));
    env_mask::mask_patch("turn", path, v) | changed
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn known() -> Vec<String> {
        vec!["sk-live-one".into()]
    }

    fn turn() -> Value {
        let blocks = json!([
            { "type": "hero", "title": "Key sk-live-one is live", "summary": "Checked sk-live-one.", "status": "done" },
            { "type": "markdown", "text": "The key sk-live-one works.\nOTHER_TOKEN=tok-unread-654321" },
            { "type": "code", "file": ".env", "code": "API_KEY=sk-live-one\nPORT=3000" }
        ]);
        let text = format!("Marker: sk-live-one\n```wisp\n{}\n```", json!({ "blocks": blocks }));
        json!({ "id": "t1", "sessionId": "s1", "status": "done", "presentation": { "blocks": blocks, "v": 3 }, "text": text, "ext": {} })
    }

    fn row(body: Value) -> Value {
        let mut r = json!({ "id": "t1", "session_id": "s1", "answer": body["text"].clone() });
        r["body"] = body;
        r
    }

    fn leaks(v: &Value) -> bool {
        let s = v.to_string();
        s.contains("sk-live") || s.contains("tok-unread")
    }

    #[test]
    fn a_rows_kept_ranges_mask_its_prose_with_nothing_known_and_the_env_block_keeps_its_reveal_flag() {
        let mut body = turn();
        body["envHide"] = hide_of(&body, Some(&known()));
        let mut r = row(body);
        assert!(mask_row(&mut r, None));
        assert!(!leaks(&r), "{r}");
        let b = &r["body"]["presentation"]["blocks"];
        assert_eq!(b[0]["title"], format!("Key {DOTS} is live"), "masked, not dropped");
        assert_eq!(b[0]["type"], "hero");
        assert_eq!(b[1]["text"], format!("The key {DOTS} works.\nOTHER_TOKEN={DOTS}"), "a .env line, its value never read");
        assert_eq!(b[2]["masked"], true, "the .env block's own rules ran: Reveal has something to ask for");
        assert_eq!(r["answer"], r["body"]["text"], "the answer column leaves as the body's text");
    }

    #[test]
    fn a_turn_stored_before_ranges_masks_against_known_values_or_hides_its_prose_whole() {
        let mut r = row(turn());
        assert!(mask_row(&mut r, Some(&known())));
        assert!(!leaks(&r), "{r}");
        assert_eq!(r["body"]["presentation"]["blocks"][0]["summary"], format!("Checked {DOTS}."));
        let mut r = row(turn());
        assert!(mask_row(&mut r, None));
        assert!(!leaks(&r), "fail closed: {r}");
        assert_eq!(r["body"]["presentation"]["blocks"][0]["title"], DOTS);
        assert_eq!(r["body"]["presentation"]["blocks"][0]["type"], "hero", "structure stays");
        assert_eq!(r["body"]["text"], DOTS);
    }

    #[test]
    fn a_turn_whose_task_read_nothing_is_left_as_it_is() {
        let mut body =
            json!({ "id": "t1", "presentation": { "blocks": [{ "type": "hero", "title": "All green", "status": "done" }] }, "text": "ok" });
        body["envHide"] = hide_of(&body, Some(&[]));
        assert!(body.pointer("/envHide/#clean").is_some(), "{body}");
        let mut r = row(body.clone());
        assert!(!mask_row(&mut r, None));
        assert_eq!(r["body"], body);
        let mut r = row(body.clone());
        r["answer"] = json!("API_KEY=abcdefgh");
        mask_row(&mut r, None);
        assert_eq!(r["answer"], DOTS, "an answer column that isn't the body's text has no ranges: fail closed");
    }

    #[test]
    fn unread_values_hide_the_prose_until_the_next_write() {
        let mut body = turn();
        body["envHide"] = hide_of(&body, None);
        let mut r = row(body);
        mask_row(&mut r, Some(&[]));
        assert_eq!(r["body"]["presentation"]["blocks"][1]["text"], DOTS);
    }

    #[test]
    fn a_patch_masks_by_where_it_lands_and_hides_prose_whole_when_nothing_is_known() {
        let mut p = turn()["presentation"].clone();
        assert!(mask_patch("/body/presentation", &mut p, Some(&known())));
        assert!(!leaks(&p), "{p}");
        assert_eq!(p["blocks"][2]["masked"], true);
        let mut a = json!("The key is sk-live-one");
        assert!(mask_patch("/answer", &mut a, Some(&known())));
        assert_eq!(a, format!("The key is {DOTS}"));
        let mut a = json!("The key is sk-live-one");
        assert!(mask_patch("/body/text", &mut a, None));
        assert_eq!(a, DOTS, "fail closed");
        let mut st = json!("done");
        assert!(!mask_patch("/status", &mut st, None));
        let mut h = json!([[0, 4]]);
        assert!(!mask_patch("/body/envHide/~1text", &mut h, None), "a range is offsets: as it is");
    }

    #[test]
    fn a_value_with_a_quote_is_masked_where_the_raw_answer_escapes_it() {
        let v = "pa\"ss-word-123".to_owned();
        let text = format!("```wisp\n{}\n```", json!({ "blocks": [{ "type": "markdown", "text": format!("it is {v}") }] }));
        let mut body = json!({ "text": text, "presentation": { "blocks": [{ "type": "markdown", "text": format!("it is {v}") }] } });
        body["envHide"] = hide_of(&body, Some(std::slice::from_ref(&v)));
        let mut r = row(body);
        mask_row(&mut r, None);
        assert!(!r.to_string().contains("ss-word"), "{r}");
    }

    #[test]
    fn ranges_found_with_what_the_task_knows_mask_alone_and_a_value_read_since_is_looked_for() {
        let mut body =
            json!({ "presentation": { "blocks": [{ "type": "markdown", "text": "uses sk-live-one and sk-live-two" }] }, "text": "ok" });
        body["envHide"] = hide_of(&body, Some(&known()));
        let mut r = row(body.clone());
        mask_row(&mut r, Some(&known()));
        assert_eq!(
            r["body"]["presentation"]["blocks"][0]["text"],
            format!("uses {DOTS} and sk-live-two"),
            "the same values: the ranges say it"
        );
        let more = vec!["sk-live-one".to_owned(), "sk-live-two".to_owned()];
        let mut r = row(body);
        mask_row(&mut r, Some(&more));
        assert_eq!(r["body"]["presentation"]["blocks"][0]["text"], format!("uses {DOTS} and {DOTS}"), "one read since: scanned for");
    }
}
