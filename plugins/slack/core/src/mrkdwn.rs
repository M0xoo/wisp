//! Slack's markup for what leaves (v1 `slackText`, `buttonLabel`, `sections`). `&<>` are Slack's
//! control characters, so escaping them is what stops `<!channel>`, `<@U1>` and `<url|text>` working
//! at all. Text comes in already scrubbed of secrets and defused (the hub's `scrub_out`, `defuse`);
//! lengths are measured after the escaping, so an `&` can't push text over a limit or be cut in two.
use serde_json::{Value, json};

use crate::truncate;

/// Slack's advice: past 4000 a message is split or cut.
pub const MAX_TEXT: usize = 3900;
pub const MAX_SECTION: usize = 3000;
pub const MAX_LABEL: usize = 75;

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

/// Clean text as it goes: escaped, within [`MAX_TEXT`], and never ending in half an entity.
pub fn fit(clean: &str) -> String {
    let mut out = truncate(&escape(clean), MAX_TEXT);
    if let Some(body) = out.strip_suffix('…') {
        // `&am…`: the entity the cut went through goes with it
        if let Some(amp) = body.rfind('&') {
            let tail = &body[amp + 1..];
            if tail.len() <= 3 && tail.bytes().all(|b| b.is_ascii_lowercase()) {
                out = format!("{}…", &body[..amp]);
            }
        }
    }
    out
}

/// A button's label: `clean` (scrub and defuse) then [`fit`], shortened until it fits [`MAX_LABEL`].
pub fn label(text: &str, clean: &dyn Fn(&str) -> String) -> String {
    let mut n = MAX_LABEL;
    loop {
        let out = fit(&clean(&truncate(text, n)));
        if out.chars().count() <= MAX_LABEL {
            return out;
        }
        if n <= 10 {
            return truncate(&out, MAX_LABEL);
        }
        n -= 10;
    }
}

/// Text already through [`fit`], in sections Slack takes: cut at a line where one is near, and
/// never through an entity.
pub fn sections(text: &str) -> Vec<Value> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let rest = &chars[start..];
        let mut cut = rest.len();
        if cut > MAX_SECTION {
            let line = rest[..=MAX_SECTION].iter().rposition(|c| *c == '\n').unwrap_or(0);
            let amp = rest[..MAX_SECTION].iter().rposition(|c| *c == '&').unwrap_or(0);
            cut = if line > MAX_SECTION / 2 {
                line
            } else if amp > MAX_SECTION - 5 {
                amp
            } else {
                MAX_SECTION
            };
        }
        let part: String = rest[..cut].iter().collect();
        if !part.trim().is_empty() {
            out.push(json!({ "type": "section", "text": { "type": "mrkdwn", "text": part, "verbatim": true } }));
        }
        start += cut;
    }
    out
}
