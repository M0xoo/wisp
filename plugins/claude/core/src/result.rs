//! A stream-json `result` line → the turn's result (v1 adapters/claude.js resultEvent,
//! compactedResult, notCompacted and the early-result rule, edge cases 1 and 5).

use serde_json::{Value, json};
use wisp_harness_kit::js::{has_text, json_num, num, str, trim, truthy};
use wisp_harness_kit::{Re, Stats, TurnResult};

use crate::line::{Line, or_null};

/// A run's words say Claude Code is signed out (v1 agent-login.js LOGINS.claude.authFailed).
static SIGNED_OUT: Re = Re::new(concat!(
    r"(?im)^(?:Not logged in|Login expired|OAuth token revoked|Login reached its time limit|Authentication required|Failed to authenticate)\b",
    r"|please run /login|run /login to (?:sign in|re-?authenticate)|oauth (?:access )?token has (?:expired|been revoked)|authentication_error|authentication_failed"
));

/// Longer than this, the words are the agent's own answer, not a sign-in failure (v1 AUTH_FAILED_MAX).
pub const AUTH_FAILED_MAX: usize = 1200;

/// v1 `signedOutBy('claude', text)`
pub fn signed_out(text: &str) -> bool {
    wisp_harness_kit::js::len16(text) <= AUTH_FAILED_MAX && SIGNED_OUT.is_match(text)
}

/// "38k", "1.2M": a token count in words (v1 web/js/receipt.js tokenWords). toFixed and Math.round
/// round half up; integers are done exactly so ties go up as in JavaScript.
pub fn token_words(n: f64) -> String {
    if n >= 1e6 {
        if n.fract() == 0.0 && n < 9e15 {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let i = n as u64;
            if n >= 1e7 {
                return format!("{}M", (i + 500_000) / 1_000_000);
            }
            let tenths = (i + 50_000) / 100_000;
            return if tenths.is_multiple_of(10) {
                format!("{}M", tenths / 10)
            } else {
                format!("{}.{}M", tenths / 10, tenths % 10)
            };
        }
        let s = if n >= 1e7 {
            format!("{:.0}", n / 1e6)
        } else {
            format!("{:.1}", n / 1e6)
        };
        return format!("{}M", s.strip_suffix(".0").unwrap_or(&s));
    }
    if n >= 1e3 {
        return format!("{}k", wisp_harness_kit::js::number((n / 1e3 + 0.5).floor()));
    }
    wisp_harness_kit::js::number((n + 0.5).floor())
}

/// A failed sign-in can end with is_error false (subtype success, zero API time). Only when no model
/// answered: a real API duration is the agent's own answer, whatever it says.
fn unanswered(msg: &Line, auth_failed: &str) -> bool {
    let api = num(&msg.duration_api_ms);
    !api.is_some_and(|a| a > 0.0)
        && (!auth_failed.is_empty() || (api == Some(0.0) && signed_out(&str(or_null(&msg.result)))))
}

pub fn result_event(msg: &Line, auth_failed: &str) -> TurnResult {
    // v1 copied what the CLI sent (a null too), and nothing for a missing key.
    let mut stats = Stats {
        cost_usd: msg.total_cost_usd.clone(),
        duration_ms: msg.duration_ms.clone(),
        turns: msg.num_turns.clone(),
        input_tokens: msg.usage.get("input_tokens").cloned(),
        output_tokens: msg.usage.get("output_tokens").cloned(),
        ..Stats::default()
    };
    // Not in inputTokens (Anthropic counts them apart): the receipt adds them up.
    if num(&msg.usage["cache_read_input_tokens"]).is_some() {
        stats.cache_read_tokens = Some(msg.usage["cache_read_input_tokens"].clone());
    }
    if num(&msg.usage["cache_creation_input_tokens"]).is_some() {
        stats.cache_write_tokens = Some(msg.usage["cache_creation_input_tokens"].clone());
    }
    let text = str(or_null(&msg.result));
    let is_error = truthy(&msg.is_error)
        || (crate::msg::truthy(msg.subtype) && !crate::msg::is(msg.subtype, "success"))
        || unanswered(msg, auth_failed);
    TurnResult {
        text: if text.is_empty() {
            auth_failed.to_owned()
        } else {
            text
        },
        is_error,
        auth_failed: (!auth_failed.is_empty()).then_some(true),
        stop_reason: truthy(&msg.stop_reason).then(|| str(&msg.stop_reason)),
        stats: Some(Box::new(stats)),
        ..TurnResult::default()
    }
}

/// What one turn of a process has seen so far; reset by each result it reports.
#[derive(Debug, Default)]
pub struct TurnState {
    pub context_tokens: f64,
    /// 0: unknown
    pub cache_ttl_ms: f64,
    /// a /compact with no main-thread request since: the size is gone, and says 0
    pub compacted: bool,
    /// the last compact_boundary's compact_metadata, until a result takes it
    pub boundary: Option<Value>,
    /// a status that says compacting failed (its error), until a boundary says it worked
    pub unshrunk: Option<String>,
}

fn stats(ev: &mut TurnResult) -> &mut Stats {
    ev.stats.get_or_insert_with(Box::default)
}

/// A compaction's result says nothing itself (result: ''): the boundary has the numbers.
fn compacted_result(ev: &mut TurnResult, boundary: &Value) {
    let (pre, post) = (num(&boundary["pre_tokens"]), num(&boundary["post_tokens"]));
    let compact = match (pre, post) {
        (Some(a), Some(b)) => json!({ "pre": json_num(a), "post": json_num(b) }),
        _ => json!({}),
    };
    stats(ev).extra.insert("compact".into(), compact);
    if !has_text(&ev.text) {
        ev.text = match (pre, post) {
            (Some(a), Some(b)) => format!(
                "Compacted from {} to {} tokens.",
                token_words(a),
                token_words(b)
            ),
            _ => "Compacted.".into(),
        };
    }
}

/// stats.compact.none: nothing shrank, so the context stays as it was.
fn not_compacted(ev: &mut TurnResult, error: Option<&str>) {
    stats(ev)
        .extra
        .insert("compact".into(), json!({ "none": true }));
    let trimmed = trim(&ev.text).to_owned();
    ev.text = match error.filter(|e| !e.is_empty()) {
        Some(e) => e.to_owned(),
        None if !trimmed.is_empty() => trimmed,
        None => "Nothing was compacted.".into(),
    };
}

/// Whether this result ends the turn (finishing `ev` when it does). On --resume, background tasks the
/// last run left come back as a notification queued ahead of our prompt: the CLI answers it with an
/// empty, zero-turn result, then goes on to the prompt. That first one is held ('early'). A
/// compaction reports the same empty, zero-turn result, and that one is final (edge case 1).
pub fn is_final(ev: &mut TurnResult, msg: &Line, turn: &mut TurnState) -> bool {
    let local = msg.local_command.as_str() == Some("compact");
    let turns = truthy(or_null(&msg.num_turns));
    if !ev.is_error
        && !has_text(&ev.text)
        && !turns
        && turn.boundary.is_none()
        && !local
        && turn.unshrunk.is_none()
    {
        return false;
    }
    match &turn.boundary {
        // A turn that auto-compacted on its way has a boundary too: that one is an ordinary answer.
        Some(b) if !ev.is_error && (local || !turns) => compacted_result(ev, b),
        // A /compact that didn't: "Not enough messages to compact." ends in success with no boundary.
        _ if !ev.is_error && (local || (turn.unshrunk.is_some() && !has_text(&ev.text))) => {
            not_compacted(ev, turn.unshrunk.as_deref())
        }
        _ => {}
    }
    if turn.context_tokens != 0.0 || turn.compacted {
        stats(ev)
            .extra
            .insert("contextTokens".into(), json_num(turn.context_tokens));
    }
    if turn.cache_ttl_ms != 0.0 {
        stats(ev)
            .extra
            .insert("cacheTtlMs".into(), json_num(turn.cache_ttl_ms));
    }
    // One process can report several results.
    *turn = TurnState::default();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_compiles() {
        assert!(SIGNED_OUT.compiles());
    }

    #[test]
    fn token_words_round_like_javascript() {
        assert_eq!(token_words(999.0), "999");
        assert_eq!(token_words(38_400.0), "38k");
        assert_eq!(token_words(1_250_000.0), "1.3M"); // toFixed ties go up
        assert_eq!(token_words(2_000_000.0), "2M");
        assert_eq!(token_words(12_500_000.0), "13M");
    }

    #[test]
    fn edge_5_signed_out_only_when_short() {
        assert!(signed_out("Not logged in · Please run /login"));
        assert!(signed_out("Error: OAuth token has expired"));
        assert!(!signed_out(&format!("Not logged in{}", " x".repeat(700))));
        assert!(!signed_out("All done."));
    }
}
