//! Buttons, chips, panels and agent blocks, cleaned as v1's normalizeSpell did.
use serde_json::{Map, Value, json};

use super::actions::{Problems, Refs, check_action};
use crate::js::{arr, clamp_refresh, js_string, obj, or_str, str_, truthy};
use crate::schema::schema;

pub const MAX_ITEMS: usize = 40;
const WHEN_KEYS: &[&str] = &["hasPr", "prState", "state", "status", "agent", "project", "unread", "hasBranch"];
const TONES: &[&str] = &["good", "bad", "warn", "info", "neutral"];

/// A card filter keeps only the keys v1 knew; an empty one is kept too (an object is truthy).
fn when(v: Option<&Value>) -> Option<Value> {
    obj(v).map(|o| Value::Object(o.iter().filter(|(k, _)| WHEN_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()))
}

fn icon(r: &Refs, p: &mut Problems, v: Option<&Value>, at: &str) -> String {
    match v {
        None => String::new(),
        Some(Value::String(s)) if s.is_empty() => String::new(),
        Some(v) => {
            if !v.as_str().is_some_and(|s| r.vocab.icons.iter().any(|i| i == s)) {
                p.at(at, format!("icon must be one of {}", r.vocab.icons.join(", ")));
            }
            js_string(v)
        }
    }
}

fn slot_ok(r: &Refs, p: &mut Problems, slot: Option<&Value>, at: &str, allowed: &[String]) {
    let s = slot.map(js_string);
    match s {
        Some(s) if r.vocab.is_slot(&s) => {
            if !allowed.is_empty() && !allowed.contains(&s) {
                p.at(at, format!("this goes in {}", allowed.join(", ")));
            }
        }
        _ => p.at(at, format!("slot must be one of {}", r.vocab.slot_names())),
    }
}

fn names(v: Option<&Value>, n: usize) -> Value {
    Value::Array(arr(v).into_iter().map(|d| Value::from(str_(Some(d), n))).collect())
}

/// `with ?? data`, as v1 read a function's sources.
fn with_or_data(x: &Map<String, Value>) -> Option<&Value> {
    x.get("with").filter(|w| !w.is_null()).or_else(|| x.get("data"))
}

fn put(o: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        o.insert(k.into(), v);
    }
}

fn badge(r: &Refs, p: &mut Problems, x: &Map<String, Value>, at: &str) -> Option<Value> {
    let b = obj(x.get("badge"))?;
    if truthy(b.get("count")) && !r.has_data(b.get("count")) {
        p.at(at, format!("badge counts {}, which isn't a data source", js_string(&b["count"])));
    }
    if truthy(b.get("fn")) {
        r.need_fn(p, b.get("fn"), at);
    }
    Some(if truthy(b.get("count")) {
        json!({ "count": str_(b.get("count"), 40) })
    } else if truthy(b.get("fn")) {
        json!({ "fn": str_(b.get("fn"), 60), "data": names(with_or_data(b), 40) })
    } else {
        json!({ "text": str_(b.get("text"), 40) })
    })
}

pub fn buttons(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, b)| {
        let at = format!("buttons[{i}]");
        let x = b.as_object().unwrap_or(&empty);
        slot_ok(r, p, x.get("slot"), &at, &schema().button_slots);
        let label = str_(x.get("label"), 40);
        if label.is_empty() && !truthy(x.get("icon")) {
            p.at(&at, "needs a label or an icon");
        }
        let bd = badge(r, p, x, &at);
        let mut o = Map::new();
        o.insert("id".into(), Value::from(str_(Some(&or_str(x.get("id"), &format!("b{i}"))), 40)));
        put(&mut o, "slot", x.get("slot").cloned());
        o.insert("label".into(), Value::from(label));
        o.insert("icon".into(), Value::from(icon(r, p, x.get("icon"), &at)));
        o.insert("title".into(), Value::from(str_(x.get("title"), 120)));
        put(&mut o, "badge", bd);
        put(&mut o, "group", truthy(x.get("group")).then(|| Value::from(str_(x.get("group"), 30))));
        put(&mut o, "corner", truthy(x.get("corner")).then(|| Value::from(if x.get("corner") == Some(&json!("bottom-left")) { "bottom-left" } else { "bottom-right" })));
        put(&mut o, "key", truthy(x.get("key")).then(|| Value::from(str_(x.get("key"), 20))));
        put(&mut o, "when", when(x.get("when")));
        put(&mut o, "primary", truthy(x.get("primary")).then_some(Value::Bool(true)));
        o.insert("do".into(), check_action(x.get("do"), &at, p, r, false).unwrap_or(Value::Null));
        Value::Object(o)
    }).collect()
}

pub fn chips(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, c)| {
        let at = format!("chips[{i}]");
        let x = c.as_object().unwrap_or(&empty);
        slot_ok(r, p, x.get("slot"), &at, &schema().chip_slots);
        if !truthy(x.get("text")) && !truthy(x.get("fn")) {
            p.at(&at, "needs text (a {field} template) or fn");
        }
        r.need_fn(p, x.get("fn"), &at);
        let mut o = Map::new();
        o.insert("id".into(), Value::from(str_(Some(&or_str(x.get("id"), &format!("c{i}"))), 40)));
        put(&mut o, "slot", x.get("slot").cloned());
        o.insert("text".into(), Value::from(str_(x.get("text"), 120)));
        if truthy(x.get("fn")) {
            o.insert("fn".into(), Value::from(str_(x.get("fn"), 60)));
            o.insert("data".into(), names(with_or_data(x), 40));
        }
        let tone = x.get("tone").and_then(Value::as_str).filter(|t| TONES.contains(t)).unwrap_or("neutral");
        o.insert("tone".into(), Value::from(tone));
        o.insert("icon".into(), Value::from(icon(r, p, x.get("icon"), &at)));
        o.insert("title".into(), Value::from(str_(x.get("title"), 160)));
        put(&mut o, "when", when(x.get("when")));
        if truthy(x.get("do")) {
            o.insert("do".into(), check_action(x.get("do"), &at, p, r, false).unwrap_or(Value::Null));
        }
        Value::Object(o)
    }).collect()
}

fn panel(r: &Refs, p: &mut Problems, x: &Map<String, Value>, at: &str) -> Value {
    if !truthy(x.get("id")) {
        p.at(at, "needs an id");
    }
    let as_ = x.get("as").and_then(Value::as_str).filter(|a| ["dialog", "drawer", "feed", "card"].contains(a)).unwrap_or("dialog");
    let slot = x.get("slot").and_then(Value::as_str);
    if as_ == "card" && !slot.is_some_and(|s| s == "card.top" || s == "card.bottom") {
        p.at(at, "a card panel needs slot card.top or card.bottom");
    }
    if !truthy(x.get("render")) {
        p.at(at, "needs render: the script function that returns its blocks");
    }
    r.need_fn(p, x.get("render"), at);
    for d in arr(x.get("data")) {
        if !r.has_data(Some(d)) {
            p.at(at, format!("no data source named {}", js_string(d)));
        }
    }
    let empty = Map::new();
    let refresh = obj(x.get("refresh")).unwrap_or(&empty);
    let mut rf = Map::new();
    if truthy(refresh.get("every")) {
        rf.insert("every".into(), clamp_refresh(refresh.get("every")));
    }
    let on: Vec<Value> = arr(refresh.get("on")).into_iter().filter(|e| e.as_str().is_some_and(|e| ["summary", "finished", "config"].contains(&e))).cloned().collect();
    rf.insert("on".into(), Value::Array(on));
    let mut o = Map::new();
    o.insert("id".into(), Value::from(str_(x.get("id"), 40)));
    o.insert("title".into(), Value::from(str_(x.get("title"), 80)));
    o.insert("icon".into(), Value::from(icon(r, p, x.get("icon"), at)));
    o.insert("as".into(), Value::from(as_));
    if as_ == "card" {
        put(&mut o, "slot", x.get("slot").cloned());
    }
    o.insert("data".into(), names(x.get("data"), 40));
    o.insert("render".into(), Value::from(str_(x.get("render"), 60)));
    put(&mut o, "when", when(x.get("when")));
    o.insert("refresh".into(), Value::Object(rf));
    Value::Object(o)
}

pub fn panels(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, x)| panel(r, p, x.as_object().unwrap_or(&empty), &format!("panels[{i}]"))).collect()
}

fn block_type_ok(t: &str) -> bool {
    let b = t.as_bytes();
    (2..=31).contains(&b.len()) && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn blocks(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, x)| {
        let x = x.as_object().unwrap_or(&empty);
        let at = format!("blocks[{i}]");
        let t = if truthy(x.get("type")) { x.get("type").map(js_string).unwrap_or_default() } else { String::new() };
        if !block_type_ok(&t) {
            p.at(&at, "type: lowercase letters, digits and dashes");
        }
        if schema().builtin_blocks.contains(&t) {
            p.at(&at, format!("{t} is a built-in block"));
        }
        if !truthy(x.get("doc")) {
            p.at(&at, "needs doc: a JSON example and when an agent should use it");
        }
        if !truthy(x.get("render")) {
            p.at(&at, "needs render: the script function that turns it into wisp blocks");
        }
        r.need_fn(p, x.get("render"), &at);
        json!({ "type": t, "doc": str_(x.get("doc"), 400), "summary": str_(x.get("summary"), 200), "render": str_(x.get("render"), 60) })
    }).collect()
}
