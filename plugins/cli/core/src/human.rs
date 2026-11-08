//! A command's result as text, for a generated verb without `--json`: a list of objects as aligned
//! rows of their short fields, an object as `key  value` lines, a scalar as it is.

use serde_json::Value;
use wisp_cli_api::Style;

use crate::term::{self, BOLD, DIM, paint};

/// The fields a row shows first when an object has them.
const LEAD: &[&str] = &["id", "key", "name", "title", "label", "state", "status", "value", "agent", "path", "url"];

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn short(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{} items]", a.len()),
        Value::Object(o) => format!("{{{} fields}}", o.len()),
        other => scalar(other).unwrap_or_default(),
    }
}

/// The columns of a list of objects: the lead fields they have, then other scalars, up to `max`.
fn columns(list: &[Value], max: usize) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    let has = |k: &str| list.iter().any(|x| x.get(k).is_some_and(|v| scalar(v).is_some_and(|s| !s.is_empty())));
    for k in LEAD {
        if has(k) {
            cols.push((*k).to_owned());
        }
    }
    if let Some(Value::Object(first)) = list.first() {
        for (k, v) in first {
            if !cols.contains(k) && scalar(v).is_some() && has(k) {
                cols.push(k.clone());
            }
        }
    }
    cols.truncate(max);
    cols
}

pub fn render(v: &Value, s: &Style) -> Vec<String> {
    match v {
        Value::Array(list) if list.is_empty() => vec![paint(s, DIM, "(none)")],
        Value::Array(list) if list.iter().all(Value::is_object) => {
            let cols = columns(list, if s.width >= 80 { 5 } else { 3 });
            let cells: Vec<Vec<String>> = list.iter().map(|x| cols.iter().map(|c| x.get(c).map(short).unwrap_or_default()).collect()).collect();
            let n = cols.len().max(1);
            let room = s.width.saturating_sub(2 * (n - 1));
            let mut widths: Vec<usize> = (0..cols.len()).map(|i| cells.iter().map(|r| term::width(&r[i])).max().unwrap_or(0)).collect();
            // the last column takes what is left
            let used: usize = widths.iter().take(n.saturating_sub(1)).map(|w| (*w).min(room / n + 8)).sum();
            for (i, w) in widths.iter_mut().enumerate() {
                *w = if i + 1 == n { room.saturating_sub(used).max(4) } else { (*w).min(room / n + 8) };
            }
            cells
                .iter()
                .map(|r| {
                    let parts: Vec<String> = r.iter().enumerate().map(|(i, c)| if i + 1 == n { term::truncate(c, widths[i]) } else { term::pad(&term::truncate(c, widths[i]), widths[i]) }).collect();
                    let line = parts.join("  ");
                    line.trim_end().to_owned()
                })
                .collect()
        }
        Value::Array(list) => list.iter().map(|x| term::truncate(&short(x), s.width)).collect(),
        Value::Object(o) if o.is_empty() => vec![paint(s, DIM, "✓ done")],
        Value::Object(o) => {
            let kw = o.keys().map(|k| term::width(k)).max().unwrap_or(0).min(24);
            o.iter()
                .flat_map(|(k, x)| {
                    let val = match x {
                        Value::String(t) => t.clone(),
                        other => scalar(other).unwrap_or_else(|| serde_json::to_string(other).unwrap_or_default()),
                    };
                    term::hang(&format!("{}  ", paint(s, BOLD, &term::pad(k, kw))), &val, s.width).into_iter().take(6)
                })
                .collect()
        }
        other => term::wrap(&scalar(other).unwrap_or_default(), s.width),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn lists_objects_and_scalars() {
        let s = Style::plain(60);
        let got = render(&json!([{ "id": "a1", "name": "Ada", "deep": { "x": 1 } }, { "id": "b22", "name": "Grace" }]), &s);
        assert_eq!(got, ["a1   Ada", "b22  Grace"]);
        assert_eq!(render(&json!({ "key": "theme", "value": "dark" }), &s), ["key    theme", "value  dark"]);
        assert_eq!(render(&json!("ok"), &s), ["ok"]);
        assert_eq!(render(&json!([]), &s), ["(none)"]);
    }
}
