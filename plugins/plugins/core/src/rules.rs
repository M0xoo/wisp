//! The value rules a spell is held to (v1 web/js/spell-schema.js): CSS values, read-only data sources,
//! `{field}` templates, card filters and the names a script exports. Each answers `None` when fine,
//! else why not, in v1's words.
use serde_json::Value;

use crate::js::{is_js_space, js_string, truthy};
use crate::schema::schema;

/// camelCase → kebab-case, as v1 wrote CSS property names.
pub fn kebab(k: &str) -> String {
    let mut out = String::with_capacity(k.len() + 4);
    for c in k.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn style_char_ok(c: char) -> bool {
    c.is_ascii_alphanumeric() || is_js_space(c) || "#.,%()+-/'\"".contains(c)
}

/// `word\s*(`, case-insensitive, anywhere in `s`.
fn word_paren(lower: &str, word: &str) -> bool {
    lower.match_indices(word).any(|(i, _)| lower[i + word.len()..].trim_start_matches(is_js_space).starts_with('('))
}

const DISPLAYS: &[&str] = &["none", "flex", "grid", "block", "inline-flex", "inline-block"];

/// A CSS declaration on a part: the property must be one spells may set, the value plain.
pub fn style_problem(prop: &str, value: Option<&Value>) -> Option<String> {
    let p = kebab(prop);
    if !schema().style_props.contains(&p) {
        return Some(format!("{p} isn't a property spells can set"));
    }
    let v = match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    };
    if v.encode_utf16().count() > 120 {
        return Some(format!("{p}: value too long"));
    }
    let lower = v.to_lowercase();
    let banned = ["url", "expression", "attr"].iter().any(|w| word_paren(&lower, w)) || lower.contains("image-set") || lower.contains("@import") || v.contains(['\\', ';', '{', '}', '<', '>']);
    if banned || !v.chars().all(style_char_ok) {
        return Some(format!("{p}: value not allowed (no url(), imports or special characters)"));
    }
    if p == "display" && !DISPLAYS.contains(&v.trim_matches(is_js_space)) {
        return Some("display must be none, flex, grid, block, inline-flex or inline-block".into());
    }
    None
}

fn gh_write_flag(a: &str) -> bool {
    ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"].iter().any(|f| a.strip_prefix(f).is_some_and(|rest| rest.is_empty() || rest.starts_with('=')))
}

/// A `gh` data source: read-only subcommands only.
pub fn gh_problem(args: Option<&Value>) -> Option<String> {
    let list: Vec<&str> = match args.and_then(Value::as_array) {
        Some(a) if !a.is_empty() && a.iter().all(Value::is_string) => a.iter().filter_map(Value::as_str).collect(),
        _ => return Some("gh needs a list of string arguments".into()),
    };
    let cmd = list[0];
    let Some(subs) = schema().gh(cmd) else {
        return Some(format!("gh {cmd} isn't allowed (read-only commands only)"));
    };
    let Some(subs) = subs else {
        return list.iter().any(|a| gh_write_flag(a)).then(|| "gh api may only read (no -X, -f, -F or --input)".into());
    };
    let sub = list.get(1).copied();
    if sub.is_some_and(|s| subs.iter().any(|x| x == s)) {
        return None;
    }
    Some(format!("gh {cmd} {} isn't allowed (read-only commands only)", sub.unwrap_or("")))
}

/// A `wisp` data source: one of the GET routes spells may read (`:x` is one segment).
pub fn wisp_path_problem(p: Option<&Value>) -> Option<String> {
    let s = if truthy(p) { p.map(js_string).unwrap_or_default() } else { String::new() };
    if !s.starts_with('/') {
        return Some("a wisp data path starts with / (e.g. /sessions)".into());
    }
    let path = s.split('?').next().unwrap_or("");
    let route = match path.strip_prefix("/api") {
        Some(rest) if rest.starts_with('/') => rest,
        _ => path,
    };
    let parts: Vec<&str> = route.split('/').filter(|x| !x.is_empty()).collect();
    let data = &schema().wisp_data;
    let ok = data.iter().any(|pat| {
        let segs: Vec<&str> = pat.split('/').filter(|x| !x.is_empty()).collect();
        segs.len() == parts.len() && segs.iter().zip(&parts).all(|(x, p)| x.starts_with(':') || x == p)
    });
    (!ok).then(|| format!("{route} isn't readable by spells (one of {})", data.join(", ")))
}

fn lookup<'a>(ctx: &'a Value, key: &str) -> Option<&'a Value> {
    let mut v = ctx;
    for k in key.split('.') {
        v = match v {
            Value::Object(o) => o.get(k)?,
            Value::Array(a) => a.get(k.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(v)
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `{field}` templates over a context (dotted paths): "PR #{pr.number}". Missing fields become ''.
pub fn fill_template(tpl: &str, ctx: &Value) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let end = after.find(|c: char| !(is_word(c) || c == '.')).unwrap_or(after.len());
        let key = &after[..end];
        let starts_ok = key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
        if starts_ok && after[end..].starts_with('}') {
            match lookup(ctx, key) {
                None | Some(Value::Null) => {}
                Some(v @ (Value::Object(_) | Value::Array(_))) => out.push_str(&v.to_string()),
                Some(v) => out.push_str(&js_string(v)),
            }
            rest = &after[end + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(a) => a.iter().collect(),
        v => vec![v],
    }
}

fn includes(l: &Value, x: Option<&Value>) -> bool {
    x.is_some_and(|x| list(l).contains(&x))
}

/// Does a card-scoped `when` match a task's summary?
pub fn when_matches(when: Option<&Value>, s: Option<&Value>) -> bool {
    let Some(w) = when.and_then(Value::as_object) else { return true };
    let Some(s) = s.filter(|s| !s.is_null()) else { return false };
    let pr = s.get("pr").filter(|p| truthy(Some(p)));
    let has_pr = pr.is_some() || s.get("prs").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let checks: [(&str, Box<dyn Fn(&Value) -> bool>); 8] = [
        ("hasPr", Box::new(|v| has_pr == truthy(Some(v)))),
        ("prState", Box::new(|v| includes(v, pr.and_then(|p| p.get("state"))))),
        ("state", Box::new(|v| includes(v, s.get("state")))),
        ("status", Box::new(|v| includes(v, s.get("status")))),
        ("agent", Box::new(|v| includes(v, s.get("agent")))),
        ("project", Box::new(|v| list(v).iter().any(|p| Some(*p) == s.get("project") || Some(*p) == s.get("projectId")))),
        ("unread", Box::new(|v| truthy(s.get("unread")) == truthy(Some(v)))),
        ("hasBranch", Box::new(|v| truthy(s.get("branch")) == truthy(Some(v)))),
    ];
    checks.iter().all(|(k, ok)| w.get(*k).is_none_or(ok))
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$'
}
fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

fn spaces(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}
fn spaces1(s: &str) -> Option<&str> {
    let t = spaces(s);
    (t.len() < s.len()).then_some(t)
}
fn ident(s: &str) -> Option<(&str, &str)> {
    if !s.starts_with(is_ident_start) {
        return None;
    }
    let end = s.find(|c: char| !is_ident(c)).unwrap_or(s.len());
    Some((&s[..end], &s[end..]))
}

fn export_fn(after: &str) -> Option<&str> {
    let rest = spaces1(after)?;
    let rest = rest.strip_prefix("async").and_then(spaces1).filter(|r| r.starts_with("function")).unwrap_or(rest);
    let rest = spaces(rest.strip_prefix("function")?);
    let rest = spaces(rest.strip_prefix('*').unwrap_or(rest));
    ident(rest).map(|(n, _)| n)
}

fn export_const(after: &str) -> Option<&str> {
    let rest = spaces1(after)?;
    let rest = ["const", "let", "var"].iter().find_map(|k| rest.strip_prefix(k)).and_then(spaces1)?;
    let (name, rest) = ident(rest)?;
    spaces(rest).starts_with('=').then_some(name)
}

/// The function names a spell's script exports (`export function name`, `export const name =`).
pub fn script_exports(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for pass in [export_fn as fn(&str) -> Option<&str>, export_const] {
        for (i, _) in src.match_indices("export") {
            if let Some(n) = pass(&src[i + 6..])
                && !out.iter().any(|o| o == n)
            {
                out.push(n.to_owned());
            }
        }
    }
    out
}

/// Why a `split.panes` `widths` prop can't be kept.
pub fn pane_widths_problem(v: &Value) -> Option<String> {
    const WORDS: &str = "widths is relative shares like \"2,1,1\"";
    let Some(s) = v.as_str() else { return Some(format!("{WORDS}.")) };
    let parts: Vec<&str> = s.split(',').map(|x| x.trim_matches(is_js_space)).collect();
    if parts.len() > 8 {
        return Some(format!("{WORDS}: at most 8 numbers."));
    }
    let bad = |x: &&str| {
        let (int, frac) = x.split_once('.').unwrap_or((x, "0"));
        let digits = |d: &str| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit());
        !(digits(int) && digits(frac)) || x.parse::<f64>().map_or(true, |n| n <= 0.0 || n > 100.0)
    };
    parts.iter().any(bad).then(|| format!("{WORDS}: 1 to 8 numbers, each above 0 and at most 100."))
}
