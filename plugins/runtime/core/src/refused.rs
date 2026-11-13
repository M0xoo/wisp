//! A turn the harness turned down (v1 runner.js `#refused`, web/js/vendors.js `vendorOf`): the hero says so and the
//! turn keeps `refusal`, which the card reads to offer the same prompt, with what the task has seen, to a harness
//! running another vendor's model. Never by itself; never for a subagent's run (its lead reads it as it is).
//! Whether it's a refusal is `prompt::refusal::refusal_of`'s (conservative on purpose).

use serde_json::{Value, json};
use wisp_runtime_api::model::TurnRefusal;

use crate::prompt::refusal::{RefusalKind, RunEnd, refusal_of};

/// Model ids → vendor, in order: `claude-sonnet-4.5`, `anthropic/claude-…`, `openrouter/openai/gpt-5`, `o4-mini`…
const VENDORS: [(&str, &[&str]); 11] = [
    ("anthropic", &["claude", "anthropic"]),
    ("openai", &["openai", "chatgpt", "gpt", "codex"]),
    ("google", &["gemini", "gemma", "google", "vertex"]),
    ("xai", &["grok", "xai", "x-ai"]),
    ("deepseek", &["deepseek"]),
    ("alibaba", &["qwen"]),
    ("moonshot", &["kimi", "moonshot"]),
    ("zhipu", &["glm", "zhipu", "z-ai"]),
    ("mistral", &["mistral", "codestral", "devstral"]),
    ("meta", &["llama"]),
    ("cursor", &[]),
];

fn sep(c: char) -> bool {
    matches!(c, '/' | ':' | ' ' | '_' | '-' | '.')
}

/// A word that starts at the id's start or after a separator, and ends at its end, a separator or a digit.
fn word_at(m: &str, w: &str) -> bool {
    m.match_indices(w).any(|(i, _)| {
        let before = m[..i].chars().last().is_none_or(|c| sep(c) && c != '.');
        let after = m[i + w.len()..].chars().next().is_none_or(|c| sep(c) || c.is_ascii_digit());
        before && after
    })
}

/// Whose model this is; `home`: what the harness runs when given none (`Harness::vendor`), for `""`, `auto`, `default`.
pub fn vendor_of(model: &str, home: Option<&str>) -> Option<String> {
    let m = model.trim().to_lowercase();
    if m.is_empty() || m == "auto" || m == "default" {
        return home.map(str::to_owned);
    }
    for (v, needles) in VENDORS {
        if needles.iter().any(|n| m.contains(n)) {
            return Some(v.to_owned());
        }
    }
    // the bare names: opus, sonnet, haiku, fable; o3, o4-mini; composer
    if ["opus", "sonnet", "haiku", "fable"].iter().any(|w| word_at(&m, w)) {
        return Some("anthropic".into());
    }
    if m.split(|c: char| sep(c) && c != '.').any(|p| p.len() >= 2 && p.starts_with('o') && p[1..].chars().all(|c| c.is_ascii_digit())) {
        return Some("openai".into());
    }
    if word_at(&m, "composer") {
        return Some("cursor".into());
    }
    home.map(str::to_owned)
}

/// The turn's end, as the refusal check reads it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ended<'a> {
    pub text: &'a str,
    pub stop_reason: &'a str,
    pub is_error: bool,
    /// files the turn changed
    pub changes: usize,
    pub agent: &'a str,
    pub model: &'a str,
    /// the harness's name ("Claude Code"), for the hero
    pub name: &'a str,
    /// the harness's own vendor (`Harness::vendor`)
    pub home: Option<&'a str>,
}

/// The refusal and the turn's blocks with its hero, or None when it wasn't one. `blocks`: what the turn showed.
pub fn refused(e: &Ended<'_>, blocks: &[Value]) -> Option<(TurnRefusal, Vec<Value>)> {
    let r = refusal_of(&RunEnd { text: e.text, stop_reason: e.stop_reason, is_error: e.is_error, changes: e.changes })?;
    let kind = match r.kind {
        RefusalKind::Policy => "policy",
        RefusalKind::Declined => "declined",
    };
    let refusal = TurnRefusal {
        agent: e.agent.to_owned(),
        model: e.model.to_owned(),
        vendor: vendor_of(e.model, e.home),
        kind: kind.into(),
        line: (!r.line.is_empty()).then_some(r.line),
    };
    let name = if e.name.is_empty() { "This harness" } else { e.name };
    let rest: Vec<Value> =
        blocks.iter().filter(|b| !matches!(b.get("type").and_then(Value::as_str), Some("hero" | "next"))).cloned().collect();
    let mut out = vec![
        json!({ "type": "hero", "title": format!("{name} turned this task down"), "summary": "Hand the same prompt, with what this task has seen, to another agent, or rephrase it and follow up.", "status": "blocked" }),
    ];
    if rest.is_empty() {
        out.push(json!({ "type": "markdown", "text": if e.text.is_empty() { "No answer." } else { e.text } }));
    } else {
        out.extend(rest);
    }
    Some((refusal, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_models_vendor_is_read_from_its_id_or_the_harness_default() {
        for (m, v) in [
            ("claude-sonnet-4.5", "anthropic"),
            ("anthropic/claude-x", "anthropic"),
            ("opus", "anthropic"),
            ("fable", "anthropic"),
            ("openrouter/openai/gpt-5", "openai"),
            ("o4-mini", "openai"),
            ("gemini-3-pro", "google"),
            ("grok-4", "xai"),
            ("qwen3-coder", "alibaba"),
            ("composer-1", "cursor"),
        ] {
            assert_eq!(vendor_of(m, None).as_deref(), Some(v), "{m}");
        }
        assert_eq!(vendor_of("", Some("anthropic")).as_deref(), Some("anthropic"), "the harness's own");
        assert_eq!(vendor_of("auto", None), None, "a harness that runs anything: unknown");
        assert_eq!(vendor_of("my-model", None), None);
    }

    #[test]
    fn a_turn_turned_down_says_so_and_keeps_the_refusal() {
        let e = Ended {
            text: "I can't help with that.",
            agent: "claude",
            model: "opus",
            name: "Claude Code",
            home: Some("anthropic"),
            ..Ended::default()
        };
        let (r, blocks) = refused(&e, &[json!({ "type": "hero", "title": "x" })]).unwrap();
        assert_eq!(
            (r.kind.as_str(), r.vendor.as_deref(), r.line.as_deref()),
            ("declined", Some("anthropic"), Some("I can't help with that."))
        );
        assert_eq!(blocks[0]["title"], "Claude Code turned this task down");
        assert_eq!(blocks[1]["text"], "I can't help with that.", "the answer stays under it");
        let policy = Ended { text: "x", stop_reason: "refusal", ..e };
        assert_eq!(refused(&policy, &[]).unwrap().0.kind, "policy");
        let worked = Ended { changes: 2, ..e };
        assert!(refused(&worked, &[]).is_none(), "a run that changed files wasn't a refusal");
        assert!(refused(&Ended { text: "I can't find the file, so I created it.", ..e }, &[]).is_none());
    }
}
