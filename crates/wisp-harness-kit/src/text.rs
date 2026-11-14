//! Small text helpers every harness parser uses (v1 `server/util.js` clip, `adapters/common.js` flatten).

use serde_json::Value;

use crate::js;

/// One line, at most `n` characters (UTF-16 units, as v1 counted), whitespace collapsed: `clip(s, n)`.
pub fn clip(s: &str, n: usize) -> String {
    let collapsed = js::collapse_space(s);
    let t = js::trim(&collapsed);
    if js::len16(t) > n {
        let mut out = js::head16(t, n.saturating_sub(1)).to_owned();
        out.push('…');
        out
    } else {
        t.to_owned()
    }
}

/// `clip(v, n)` over a JSON value: `String(v ?? '')` first.
pub fn clip_value(v: &Value, n: usize) -> String {
    clip(&js::str(v), n)
}

/// A tool result's content (a string, or a list of `{text}` parts) as one string.
pub fn flatten(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            let mut out = String::new();
            for (i, p) in parts.iter().enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                // v1 `c.text || ''`: a part's text when it has a truthy one.
                if js::truthy(&p["text"]) {
                    out.push_str(&js::str(&p["text"]));
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// The first letter lower-cased.
pub fn lower(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().chain(c).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_counts_utf16_and_collapses() {
        assert_eq!(clip("  a\n\nb  ", 80), "a b");
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(clip("abcd", 4), "abcd");
        assert_eq!(clip("", 4), "");
    }

    #[test]
    fn flatten_parts() {
        assert_eq!(flatten(&json!("x")), "x");
        assert_eq!(flatten(&json!([{"text": "a"}, {"type": "image"}, {"text": "b"}])), "a\n\nb");
        assert_eq!(flatten(&json!(null)), "");
    }
}
