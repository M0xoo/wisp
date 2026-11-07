//! JavaScript's semantics for the few operations v1's parsers lean on, so the port says byte for byte
//! what v1 said: truthiness, `String(v)`, `\s` and `trim()`, and lengths and slices in UTF-16 units.
//! Parsers read untrusted CLI JSON field by field; `serde_json::Value`'s `v["key"]` already answers
//! `Null` for a missing key or a non-object, which is JavaScript's `undefined` for our purposes.

use serde_json::Value;

/// JavaScript's `\s` (and what `trim()` strips): ASCII space and controls, NBSP, the Unicode spaces,
/// line and paragraph separators and the BOM.
pub const fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `s.trim()`
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.trim()` is not empty
pub fn has_text(s: &str) -> bool {
    !trim(s).is_empty()
}

/// `s.replace(/\s+/g, ' ')`
pub fn collapse_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `s.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The byte offset of UTF-16 unit `n` (clamped to the end). A cut inside a surrogate pair moves back to
/// the character's start: JavaScript would leave half a pair, which no Rust string can hold.
pub fn byte_at16(s: &str, n: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let next = units + c.len_utf16();
        if next > n {
            return i;
        }
        units = next;
    }
    s.len()
}

/// `s.slice(0, n)` in UTF-16 units.
pub fn head16(s: &str, n: usize) -> &str {
    &s[..byte_at16(s, n)]
}

/// `s.slice(from)` in UTF-16 units.
pub fn tail16(s: &str, from: usize) -> &str {
    &s[byte_at16(s, from)..]
}

/// `s.slice(-n)` in UTF-16 units.
pub fn last16(s: &str, n: usize) -> &str {
    let total = len16(s);
    if n >= total { s } else { tail16(s, total - n) }
}

/// JavaScript truthiness: `null`, `undefined`, `false`, `0`, `NaN` and `''` are false.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A JavaScript number as `String(n)` says it: integers without a fraction, the rest shortest round-trip.
pub fn number(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if f == 0.0 {
        return "0".into();
    }
    if (1e-6..1e21).contains(&f.abs()) {
        // Rust's shortest round-trip agrees with JavaScript in this range.
        return format!("{f}");
    }
    // Exponent form: JavaScript writes `1e+21`, `1.5e-7`.
    let sci = format!("{f:e}");
    match sci.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => sci,
    }
}

/// `String(v)`: `undefined`/`null` as their names, arrays joined with commas, objects as `[object Object]`.
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => num_string(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn num_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        #[allow(clippy::cast_precision_loss)] // past 2^53 JavaScript has lost the digits too
        return number(u as f64);
    }
    number(n.as_f64().unwrap_or(f64::NAN))
}

/// The reference port's `str`: a string as is, `null`/`undefined` as `''`, anything else `String(v)`.
pub fn str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => string(other),
    }
}

/// A borrowed string when `v` is one, else `''` (for the common read of a string field).
pub fn str_ref(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// A finite number, or None (the reference port's `num`).
pub fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.is_finite())
}

/// `Number(v) || 0` for counters: a number or a numeric string, else 0.
pub fn number_or_zero(v: &Value) -> f64 {
    let f = match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => {
            let t = trim(s);
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(0.0)
            }
        }
        Value::Bool(true) => 1.0,
        _ => 0.0,
    };
    if f.is_nan() { 0.0 } else { f }
}

/// `v || fallback` over two values.
pub fn or<'a>(v: &'a Value, fallback: &'a Value) -> &'a Value {
    if truthy(v) { v } else { fallback }
}

/// A JSON number from an f64 (integers stay integers, as JavaScript's JSON.stringify writes them).
pub fn json_num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        #[allow(clippy::cast_possible_truncation)]
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// An array's items, or none.
pub fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_is_javascripts() {
        for v in [json!(null), json!(false), json!(0), json!(0.0), json!("")] {
            assert!(!truthy(&v), "{v}");
        }
        for v in [
            json!(true),
            json!(1),
            json!(-0.5),
            json!("0"),
            json!([]),
            json!({}),
        ] {
            assert!(truthy(&v), "{v}");
        }
    }

    #[test]
    fn string_matches_javascript() {
        assert_eq!(string(&json!(1)), "1");
        assert_eq!(string(&json!(1.5)), "1.5");
        assert_eq!(string(&json!(0.1)), "0.1");
        assert_eq!(string(&json!(1e21)), "1e+21");
        assert_eq!(number(1.5e-7), "1.5e-7");
        assert_eq!(number(0.000_001), "0.000001");
        assert_eq!(string(&json!([1, "a", null])), "1,a,");
        assert_eq!(string(&json!({"a": 1})), "[object Object]");
        assert_eq!(str(&json!(null)), "");
    }

    #[test]
    fn utf16_slices() {
        let s = "a😀b";
        assert_eq!(len16(s), 4);
        assert_eq!(head16(s, 2), "a"); // half a pair moves back
        assert_eq!(head16(s, 3), "a😀");
        assert_eq!(tail16(s, 3), "b");
        assert_eq!(last16(s, 1), "b");
    }

    #[test]
    fn spaces_are_javascripts() {
        assert_eq!(collapse_space(" a \u{a0}\t b\u{feff}"), " a b ");
        assert_eq!(trim("\u{feff} x \u{2028}"), "x");
        assert!(!is_space('\u{85}')); // Rust's whitespace, not JavaScript's
    }
}
