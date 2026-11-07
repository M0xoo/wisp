//! `parts` (restyle, props, order) and `ui` (hide, tokens), cleaned as v1 did.
use serde_json::{Map, Value};
use wisp_plugins_api::PropType;

use super::actions::{Problems, Refs};
use crate::js::{arr, js_string, js_trim, obj, str_, truthy};
use crate::rules::{kebab, pane_widths_problem, style_problem};
use crate::schema::schema;

/// Why a prop value doesn't fit its type, in v1's words.
fn prop_problem(t: &PropType, val: &Value) -> Option<String> {
    match t {
        PropType::OneOf(list) => (!val.as_str().is_some_and(|v| list.iter().any(|x| x == v))).then(|| list.join(" | ")),
        PropType::Named(name) => {
            if let Some((lo, hi)) = schema().range(name) {
                let ok = val.as_f64().is_some_and(|f| f.fract() == 0.0 && f >= lo as f64 && f <= hi as f64);
                return (!ok).then(|| format!("{name} from {lo} to {hi}"));
            }
            if name == "bool" {
                return (!val.is_boolean()).then(|| "bool".into());
            }
            (!val.is_string()).then(|| name.clone())
        }
    }
}

fn props(r: &Refs, p: &mut Problems, name: &str, raw: Option<&Value>, at: &str) -> Value {
    let allowed = r.vocab.props_of(name);
    let mut out = Map::new();
    for (k, val) in obj(raw).into_iter().flatten() {
        let Some((_, t)) = allowed.iter().find(|(n, _)| n == k) else {
            let names: Vec<&str> = allowed.iter().map(|(n, _)| n.as_str()).collect();
            let list = if names.is_empty() { String::new() } else { format!(" ({})", names.join(", ")) };
            p.at(at, format!("{k} isn't a prop of {name}{list}"));
            continue;
        };
        if let Some(why) = prop_problem(t, val) {
            p.at(at, format!("{k}: {why}"));
        } else if let Some(why) = (name == "split.panes" && k == "widths").then(|| pane_widths_problem(val)).flatten() {
            p.at(at, why);
        } else {
            out.insert(k.clone(), if val.is_string() { Value::from(str_(Some(val), 160)) } else { val.clone() });
        }
    }
    Value::Object(out)
}

fn style(p: &mut Problems, raw: Option<&Value>, at: &str) -> Value {
    let mut out = Map::new();
    for (k, val) in obj(raw).into_iter().flatten() {
        match style_problem(k, Some(val)) {
            Some(e) => p.at(at, e),
            None => {
                out.insert(kebab(k), Value::from(js_trim(&js_string(val))));
            }
        }
    }
    Value::Object(out)
}

pub fn parts(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let order_names = &schema().card_head_order;
    for (name, v) in obj(raw).into_iter().flatten() {
        let at = format!("parts.{name}");
        if !r.vocab.is_part(name) {
            p.at(&at, "not a part (see the part list)");
            continue;
        }
        let x = v.as_object();
        let get = |k: &str| x.and_then(|x| x.get(k));
        let mut part = Map::new();
        if truthy(get("style")) {
            part.insert("style".into(), style(p, get("style"), &at));
        }
        if truthy(get("props")) {
            part.insert("props".into(), props(r, p, name, get("props"), &at));
        }
        if truthy(get("order")) {
            if name != "card.head" {
                p.at(&at, "order is only for card.head");
            }
            let all = arr(get("order"));
            let order: Vec<Value> = all.iter().filter(|k| order_names.contains(&js_string(k))).map(|v| (*v).clone()).collect();
            if order.len() != all.len() {
                p.at(&at, format!("order takes {}", order_names.join(", ")));
            }
            part.insert("order".into(), Value::Array(order));
        }
        out.insert(name.clone(), Value::Object(part));
    }
    out
}

fn tokens(r: &Refs, p: &mut Problems, raw: Option<&Value>, at: &str) -> Map<String, Value> {
    obj(raw)
        .into_iter()
        .flatten()
        .filter(|(k, v)| {
            if !r.vocab.tokens.contains(k) {
                p.at(at, format!("{k} isn't a token ({})", r.vocab.tokens.join(", ")));
                return false;
            }
            if style_problem("color", Some(v)).is_some() {
                p.at(at, format!("{k}: value not allowed"));
                return false;
            }
            true
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// `ui`: the cleaned object (None when it holds nothing), warnings for hiding the reply box.
pub fn ui(r: &Refs, p: &mut Problems, raw: Option<&Value>, warnings: &mut Vec<String>) -> Option<Value> {
    let u = raw.and_then(Value::as_object);
    let get = |k: &str| u.and_then(|u| u.get(k));
    let hide: Vec<Value> = arr(get("hide"))
        .into_iter()
        .filter(|h| {
            let ok = r.vocab.is_part(&js_string(h));
            if !ok {
                p.at("ui.hide", format!("{} isn't a part", js_string(h)));
            }
            ok
        })
        .cloned()
        .collect();
    for h in &hide {
        let h = js_string(h);
        if schema().answer_box.contains(&h) {
            warnings.push(format!("ui.hide {h}: the reply box still shows while a task waits on your answer, since that's where you answer it"));
        }
    }
    let tok = truthy(get("tokens")).then(|| tokens(r, p, get("tokens"), "ui.tokens"));
    let dark = truthy(get("dark")).then(|| tokens(r, p, get("dark"), "ui.dark"));
    if hide.is_empty() && tok.is_none() && dark.is_none() {
        return None;
    }
    let mut o = Map::new();
    if !hide.is_empty() {
        o.insert("hide".into(), Value::Array(hide));
    }
    if let Some(t) = tok {
        o.insert("tokens".into(), Value::Object(t));
    }
    if let Some(d) = dark {
        o.insert("dark".into(), Value::Object(d));
    }
    Some(Value::Object(o))
}
