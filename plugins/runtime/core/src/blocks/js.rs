//! JavaScript's semantics where v1's output depends on them: truthiness, `String(v)`, number formatting,
//! `Number(v)`, `toFixed`, `JSON.stringify(v, null, 2)`, `encodeURIComponent` and the whitespace `\s` and
//! `trim()` mean. The parser and the markdown stand-in are pinned byte for byte against v1, so these are
//! exact, not approximations.

use std::fmt::Write as _;

use serde_json::Value;

/// JavaScript's `\s` (and what `trim()` strips): `WhiteSpace` + `LineTerminator`.
pub(crate) fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

pub(crate) fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_ws)
}

/// The byte index of the first char at or after `from` that is not `\s` (`s.len()` when none).
pub(crate) fn skip_ws(s: &str, from: usize) -> usize {
    s[from..]
        .char_indices()
        .find(|&(_, c)| !is_ws(c))
        .map_or(s.len(), |(k, _)| from + k)
}

/// `if (v)`; `None` is `undefined`.
pub(crate) fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a || b`
pub(crate) fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// `a ?? b`
pub(crate) fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        some => some,
    }
}

/// `a === b`, with objects and arrays equal only to themselves.
#[allow(clippy::many_single_char_names)] // JavaScript's `a === b`, as the spec names it
pub(crate) fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => match (x, y) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(p), Value::Bool(q)) => p == q,
            (Value::Number(p), Value::Number(q)) => p.as_f64() == q.as_f64(),
            (Value::String(p), Value::String(q)) => p == q,
            (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => {
                std::ptr::eq(x, y)
            }
            _ => false,
        },
        _ => false,
    }
}

/// `String(v)`
pub(crate) fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            let mut out = String::new();
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !x.is_null() {
                    out.push_str(&string(x));
                }
            }
            out
        }
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// v1's `str(v)`: `''` for null and undefined, else `String(v)`.
pub(crate) fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(x) => string(x),
    }
}

/// `${v}` in a template: `undefined` reads "undefined".
pub(crate) fn tpl(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_owned(), string)
}

/// `Number.prototype.toString()` (ECMA-262 `Number::toString`, radix 10).
pub(crate) fn number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if x < 0.0 {
        return format!("-{}", number(-x));
    }
    // Rust's `{:e}` is the shortest round-trip digits, as JavaScript's.
    let e = format!("{x:e}");
    let (mant, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    let zeros = |c: i64| "0".repeat(usize::try_from(c).unwrap_or(0));
    if k <= n && n <= 21 {
        format!("{digits}{}", zeros(n - k))
    } else if 0 < n && n <= 21 {
        let at = usize::try_from(n).unwrap_or(0);
        format!("{}.{}", &digits[..at], &digits[at..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", zeros(-n))
    } else {
        let sign = if n > 0 { '+' } else { '-' };
        let rest = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!("{}{rest}e{sign}{}", &digits[..1], (n - 1).abs())
    }
}

/// `Number(v)`; `None` is `undefined` (NaN).
pub(crate) fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => str_to_number(s),
        Some(a @ Value::Array(_)) => str_to_number(&string(a)),
    }
}

/// `Number(s)` for a string (`StringToNumber`).
pub(crate) fn str_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return radix_number(rest, radix);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mant, exp) = body.split_once(['e', 'E']).unwrap_or((body, ""));
    let mant_ok = mant.chars().any(|c| c.is_ascii_digit())
        && mant.chars().all(|c| c.is_ascii_digit() || c == '.')
        && mant.matches('.').count() <= 1;
    let exp_digits = exp.strip_prefix(['+', '-']).unwrap_or(exp);
    let exp_ok = !body.contains(['e', 'E'])
        || (!exp_digits.is_empty() && exp_digits.chars().all(|c| c.is_ascii_digit()));
    if mant_ok && exp_ok {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut x = 0.0_f64;
    for c in digits.chars() {
        match c.to_digit(radix) {
            Some(d) => x = x * f64::from(radix) + f64::from(d),
            None => return f64::NAN,
        }
    }
    x
}

/// `x.toFixed(digits)`: rounds the exact binary value half up, as the spec's "pick the larger n".
pub(crate) fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number(x);
    }
    if x < 0.0 {
        return format!("-{}", to_fixed(-x, digits));
    }
    // 1100 places is the exact expansion of any double (at most 1074 fraction digits).
    let exact = format!("{x:.1100}");
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes().get(digits).is_some_and(|&d| d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let s: String = kept.iter().map(|&b| char::from(b)).collect();
    if digits == 0 {
        s
    } else {
        format!("{}.{}", &s[..split], &s[split..])
    }
}

/// `JSON.stringify(v, null, 2)`. JavaScript keeps an object's keys in the author's order; `serde_json`'s
/// map sorts them, so a block's `type` (which agents write first) is put first and the rest sorted.
pub(crate) fn stringify_pretty(v: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, v, 0);
    out
}

fn write_json(out: &mut String, v: &Value, depth: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            out.push_str(&if x.is_finite() {
                number(x)
            } else {
                "null".to_owned()
            });
        }
        Value::String(s) => quote(out, s),
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Object(o) if o.is_empty() => out.push_str("{}"),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                out.push_str(if i > 0 { ",\n" } else { "\n" });
                indent(out, depth + 1);
                write_json(out, x, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            let typed = o.get("type").map(|t| ("type", t));
            let keys = typed.into_iter().chain(
                o.iter()
                    .filter(|(k, _)| k.as_str() != "type")
                    .map(|(k, x)| (k.as_str(), x)),
            );
            for (i, (k, x)) in keys.enumerate() {
                out.push_str(if i > 0 { ",\n" } else { "\n" });
                indent(out, depth + 1);
                quote(out, k);
                out.push_str(": ");
                write_json(out, x, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push('}');
        }
    }
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `encodeURIComponent(s)`
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// `s.slice(0, n)` counted in UTF-16 units. `true` when the cut falls inside a surrogate pair: JavaScript
/// keeps half a character there (a lone surrogate); the half is dropped here.
pub(crate) fn slice_utf16(s: &str, n: usize) -> (&str, bool) {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if units + w > n {
            return (&s[..i], units < n);
        }
        units += w;
    }
    (s, false)
}

/// `s.slice(0, n)` as it reaches the page: a lone surrogate becomes U+FFFD when the string is encoded.
pub(crate) fn slice_utf16_lossy(s: &str, n: usize) -> String {
    match slice_utf16(s, n) {
        (cut, true) => format!("{cut}\u{fffd}"),
        (cut, false) => cut.to_owned(),
    }
}
