//! A harness that turned a task down (v1 server/refusal.js), not one that failed or got it wrong. The
//! task then offers to hand the same prompt, with what it has seen, to another of your harnesses
//! (`turn.refusal`). Never by itself. Conservative on purpose: a false card is noise on a finished task.
//! Only the API's own word (stop_reason "refusal"), the CLI's usage-policy error, or a short answer
//! that opens by declining, from a run that changed no file.

use serde::{Deserialize, Serialize};

use super::text::{Re, js_s, len16, trim, truncate};

static POLICY: Re = Re::new(concat!(
    r"(?i)appears to violate (?:our|the) usage polic",
    r"|violat[A-Za-z0-9_]* (?:our|anthropic'?s?|openai'?s?) usage polic",
    r"|flagged as (?:potentially )?violating (?:our )?usage polic",
    r"|invalid_prompt(?-u:\b)[^\n\r\x{2028}\x{2029}]*usage polic",
    r#"|stop_reason["']?"#,
    js_s!(),
    "*[:=]",
    js_s!(),
    r#"*["']?refusal"#
));

// "I can't help with that", "I'm sorry, but I won't write…": a verb of helping, not "I can't find the file".
static DECLINE: Re = Re::new(concat!(
    r"(?i)^(?:(?:I(?:'|’)m|I am)",
    js_s!(),
    r"+(?:sorry|afraid)|sorry|I apologi[sz]e|unfortunately)?[,.!]?",
    js_s!(),
    r"*(?:but",
    js_s!(),
    r"+)?I",
    js_s!(),
    r"+(?:can(?:'|’)?t|cannot|won(?:'|’)t|will not|am not able to|(?:'|’)m not able to|am unable to|(?:'|’)m unable to|must decline to|have to decline to)",
    js_s!(),
    r"+(?:help|assist|provide|create|write|build|make|do|comply|support|continue|reverse[- ]engineer|work on|produce|generate|implement)(?-u:\b)"
));
static MARKDOWN_OPENER: Re = Re::new(concat!("^(?:[#>*_`-]|", js_s!(), ")+"));

/// a real answer that mentions what it can't do is longer than this
const DECLINE_SHORT: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefusalKind {
    /// the API or the CLI said so
    Policy,
    /// a short answer that opens by declining
    Declined,
}

/// `turn.refusal`'s kind and the line the card quotes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    pub kind: RefusalKind,
    pub line: String,
}

/// How a run ended, as far as telling a refusal goes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunEnd<'a> {
    pub text: &'a str,
    pub stop_reason: &'a str,
    pub is_error: bool,
    /// how many files it changed
    pub changes: usize,
}

/// Whether the run turned the task down (v1 `refusalOf`).
pub fn refusal_of(r: &RunEnd<'_>) -> Option<Refusal> {
    let t = trim(r.text);
    let line = truncate(t.split('\n').find(|l| !trim(l).is_empty()).unwrap_or(""), 200);
    if r.stop_reason == "refusal" || POLICY.is_match(t) {
        return Some(Refusal { kind: RefusalKind::Policy, line });
    }
    if r.is_error || r.changes > 0 || t.is_empty() || len16(t) > DECLINE_SHORT {
        return None;
    }
    // Markdown a model may open with (a heading, bold) doesn't hide the sentence.
    let plain = MARKDOWN_OPENER.replace(t, "").replace("**", "");
    DECLINE.is_match(&plain).then_some(Refusal { kind: RefusalKind::Declined, line })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [&POLICY, &DECLINE, &MARKDOWN_OPENER] {
            assert!(re.get().is_some());
        }
    }
}
