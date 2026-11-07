//! v1 checked spells in JavaScript, and a stored spell must check the same here: these helpers give
//! JS's meaning to `String(v)`, `Number(v)`, truthiness and v1's `clip`/`truncate` (lengths in UTF-16
//! units, as JS counts them).
use serde_json::{Map, Value};

/// JS `\s`: Unicode white space plus the BOM.
pub fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JS truthiness of a value that may be missing (`undefined`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS number formatting for the values JSON can hold.
pub fn num_string(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        format!("{f}")
    }
}

/// `String(v)`.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), num_string),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(v ?? '')` for a value that may be missing.
pub fn js_string_or(v: Option<&Value>, or: &str) -> String {
    match v {
        None | Some(Value::Null) => or.to_owned(),
        Some(v) => js_string(v),
    }
}

/// `Number(v)`.
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => str_number(s),
        Some(Value::Array(a)) => match a.as_slice() {
            [] => 0.0,
            [x] => str_number(&js_string(x)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn str_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if t.contains(|c: char| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => f64::NAN,
        _ => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// `Number(v) || or`.
pub fn number_or(v: Option<&Value>, or: f64) -> f64 {
    let n = js_number(v);
    if n == 0.0 || n.is_nan() { or } else { n }
}

/// A number as JSON: an integer when it is one (as JSON.stringify writes it), null for NaN.
pub fn num(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    // Integers below 2^53 are exact in f64, so the cast keeps the value.
    #[allow(clippy::cast_possible_truncation)]
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// v1's refresh rule: `Math.min(Math.max(Number(v) || 60, 10), 3600)`.
pub fn clamp_refresh(v: Option<&Value>) -> Value {
    num(number_or(v, 60.0).clamp(10.0, 3600.0))
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The first `n` UTF-16 units of `s` (a pair JS would split is left out whole): `s.slice(0, n)`.
pub fn slice_utf16(s: &str, n: usize) -> &str {
    cut_utf16(s, n)
}

fn cut_utf16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        used += c.len_utf16();
        if used > n {
            return &s[..i];
        }
    }
    s
}

/// Kept as written (line breaks too), only capped at `n` (UTF-16 units), with an ellipsis.
pub fn truncate(s: &str, n: usize) -> String {
    if utf16_len(s) > n { format!("{}…", cut_utf16(s, n.saturating_sub(1))) } else { s.to_owned() }
}

/// One line, at most `n` (v1 util.js clip).
pub fn clip(s: &str, n: usize) -> String {
    let mut one = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if is_js_space(c) {
            space = true;
        } else {
            if space && !one.is_empty() {
                one.push(' ');
            }
            space = false;
            one.push(c);
        }
    }
    truncate(&one, n)
}

/// v1 `str(v, n)`: '' for missing or null, else `clip(String(v), n)`.
pub fn str_(v: Option<&Value>, n: usize) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => clip(&js_string(v), n),
    }
}

/// v1 `arr(v)`: a list, a lone value as a list of one, nothing as none.
pub fn arr(v: Option<&Value>) -> Vec<&Value> {
    match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(v) => vec![v],
    }
}

/// v1 `obj(v)`: a plain object, or None.
pub fn obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

/// A field that is present and not null (`x.k !== undefined` where JSON has no undefined).
pub fn has(o: &Map<String, Value>, k: &str) -> bool {
    o.get(k).is_some()
}

/// v1's `x.k || fallback` for a string-ish field.
pub fn or_str(v: Option<&Value>, fallback: &str) -> Value {
    if truthy(v) { v.cloned().unwrap_or(Value::Null) } else { Value::from(fallback) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strings_and_numbers_follow_js() {
        assert_eq!(js_string(&json!(12)), "12");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({})), "[object Object]");
        assert!(js_number(Some(&json!("x"))).is_nan());
        assert!((js_number(Some(&json!(" 12 "))) - 12.0).abs() < f64::EPSILON);
        assert!(js_number(Some(&json!(""))).abs() < f64::EPSILON);
        assert_eq!(clamp_refresh(Some(&json!("abc"))), json!(60));
        assert_eq!(clamp_refresh(Some(&json!(5))), json!(10));
        assert_eq!(clamp_refresh(Some(&json!(99_999))), json!(3600));
        assert_eq!(clamp_refresh(Some(&json!(12.5))), json!(12.5));
    }

    #[test]
    fn clip_collapses_space_and_caps_in_utf16_units() {
        assert_eq!(clip("  a \n\t b  ", 80), "a b");
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(truncate("a\nb", 10), "a\nb");
        // an emoji is two units in JS
        assert_eq!(truncate("😀😀😀", 4), "😀…");
        assert!(!truthy(Some(&json!(0))) && !truthy(Some(&json!(""))) && truthy(Some(&json!([]))));
    }
}
