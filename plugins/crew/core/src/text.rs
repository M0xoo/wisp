//! Small text helpers v1 kept in util.js. Lengths count characters (v1 counted UTF-16 units; the
//! limits are the same numbers, a little more generous for astral characters).

/// Whitespace runs become one space, ends trimmed (v1 `.replace(/\s+/g, ' ').trim()`).
pub fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first `n` characters (v1 `.slice(0, n)`).
pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The last `n` characters (v1 `.slice(-n)`).
pub fn tail(s: &str, n: usize) -> String {
    let len = s.chars().count();
    s.chars().skip(len.saturating_sub(n)).collect()
}

/// At most `n` characters, an ellipsis replacing the last one when cut (v1 util.truncate).
pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Letters and digits of any script (v1 `[\p{L}\p{N}]`).
pub fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

/// `\r\n` → `\n`.
pub fn unix(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// A JSON value as v1's `String(v)`: strings as they are, numbers and booleans printed, null and
/// missing as ''.
pub fn str_of(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// `1234` → `1,234` (v1 `toLocaleString('en')`).
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}
