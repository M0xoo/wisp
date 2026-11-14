//! A task's topic tags (v1 web/js/tags.js `normalizeTags`, routes/internal.js `/internal/tags`): the words
//! its agent sets with `wisp_tag`, which the user searches it by (⌘K, `#tag`). Pure.

use serde_json::Value;

/// At most this many tags on a task.
pub const MAX_TAGS: usize = 10;
/// A tag is cut to this many characters.
const MAX_LEN: usize = 32;

/// What `wisp_tag` answers when the list has no usable word.
pub const NONE_GIVEN: &str = "Give 3 to 8 short topic words, e.g. [\"auth\", \"rate-limit\", \"redis\"].";

/// One raw word as a tag: lowercase, no leading `#`, spaces, `_` and `/` as `-`, only letters, digits and
/// `- . +`, no repeated `-`, no `-` or `.` at either end, at most `MAX_LEN` characters.
fn one(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let s = lower.trim().trim_start_matches('#');
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_whitespace() || c == '_' || c == '/' {
            gap = true;
            continue;
        }
        if gap {
            out.push('-');
            gap = false;
        }
        if c.is_alphanumeric() || matches!(c, '-' | '.' | '+') {
            out.push(c);
        }
    }
    let mut squeezed = String::with_capacity(out.len());
    for c in out.chars() {
        if !(c == '-' && squeezed.ends_with('-')) {
            squeezed.push(c);
        }
    }
    squeezed.trim_matches(['-', '.']).chars().take(MAX_LEN).collect()
}

/// v1 `normalizeTags`: a list (or a comma-separated string) as tags; duplicates and empties go, at most
/// `MAX_TAGS`. "Rate Limiting", "#Redis", "next.js" → "rate-limiting", "redis", "next.js".
pub fn normalize(list: &Value) -> Vec<String> {
    let raw: Vec<String> = match list {
        Value::Array(a) => a
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => String::new(),
            })
            .collect(),
        Value::String(s) => s.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let t = one(&r);
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
        if out.len() == MAX_TAGS {
            break;
        }
    }
    out
}

/// What `wisp_tag` answers once the task is tagged; `given`: how many the agent sent.
pub fn tagged_text(tags: &[String], given: usize) -> String {
    let list: Vec<String> = tags.iter().map(|t| format!("#{t}")).collect();
    let cut = if given > MAX_TAGS { format!(" (only the first {MAX_TAGS} are kept)") } else { String::new() };
    format!("Tagged: {}{cut}. Call wisp_tag again only if the work moves to another topic; it replaces these.", list.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tags_are_normalised_like_v1() {
        assert_eq!(
            normalize(&json!(["Rate Limiting", "#Redis", "next.js", "a__b//c", "--x--", "c++", "redis", "", "  ", 5, null])),
            vec!["rate-limiting", "redis", "next.js", "a-b-c", "x", "c++", "5"]
        );
        assert_eq!(normalize(&json!("auth, Billing ,auth")), vec!["auth", "billing"]);
        assert_eq!(normalize(&json!({ "a": 1 })), Vec::<String>::new());
        assert_eq!(normalize(&json!(["é-Ünïcode!?", ".dot."])), vec!["é-ünïcode", "dot"]);
        assert_eq!(normalize(&json!(["x".repeat(40)]))[0].len(), 32);
    }

    #[test]
    fn at_most_ten_tags_are_kept_and_the_answer_says_so() {
        let many: Vec<String> = (0..12).map(|i| format!("t{i}")).collect();
        let tags = normalize(&json!(many));
        assert_eq!(tags.len(), MAX_TAGS);
        assert_eq!(
            tagged_text(&tags[..2], 12),
            "Tagged: #t0 #t1 (only the first 10 are kept). Call wisp_tag again only if the work moves to another topic; it replaces these."
        );
        assert!(!tagged_text(&tags, 3).contains("only the first"));
    }
}
