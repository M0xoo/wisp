//! The cold cache and Compact now (v1 web/js/cold-cache.js), sans-IO: `at` comes in.
//!
//! - [`cold_cache`]: a large idle task whose provider prompt cache has lapsed (or when it will): the next
//!   reply re-reads the whole conversation. Only ever words: nothing here holds, asks or pauses a send.
//! - [`compact_offer`]: a large warm Claude task can shrink to a summary before its cache lapses; the
//!   estimate of compacting now against the same reply once the cache is cold, at API list prices.
//!
//! Harness-agnostic for the cold line: it reads only a turn's stats, so a harness that reports no
//! `cacheTtlMs` (every one but Claude today) never shows it.

pub use wisp_runtime_api::commands::{ColdCache as Cold, CompactOffer as Offer};
use wisp_runtime_api::model::{Session, SessionState, Turn, TurnStats};
#[cfg(test)]
use wisp_runtime_api::model::TurnStatus;

/// Tokens worth a line: at or just under the median cold write in v1's transcripts (99k–119k vs 1–6k warm).
pub const LARGE: u64 = 100_000;
/// The cache outlives its TTL: alive in 21 of 38 cases at 60–75 min, 0 of 52 past 75 min (v1's 1,500 transcripts).
pub const GRACE: f64 = 1.25;
/// Compact now is offered from here.
pub const COMPACT_MIN: u64 = 200_000;
/// Estimates (v1 reports/2026-11-05-rerank23): the summary writes ~20k output, the next turn ~30k to the cache.
const COMPACT_OUTPUT: f64 = 20_000.0;
const COMPACT_WRITE: f64 = 30_000.0;
/// A cache write as a multiple of input: 1 h, 5 min.
const WRITE_1H: f64 = 2.0;
const WRITE_5M: f64 = 1.25;

/// USD per million tokens, API list, by the main thread's model: input, cache read, output.
pub const PRICES: [(&str, [f64; 3]); 5] = [
    ("claude-opus-5-5", [4.0, 0.2, 20.0]),
    ("claude-sonnet-5-5", [2.0, 0.2, 10.0]),
    // v1 #763: Fable 5.2 lists at $8 / $0.20 / $40
    ("claude-fable-5-2", [8.0, 0.2, 40.0]),
    ("claude-fable-5-1", [10.0, 0.25, 50.0]),
    ("claude-fable-5", [10.0, 0.25, 50.0]),
];

/// A model's list price, by its bare id (`[1m]` and a `-YYYYMMDD` date dropped).
pub fn price(model: &str) -> Option<[f64; 3]> {
    let id = bare_model(model);
    PRICES.iter().find(|(k, _)| *k == id).map(|(_, p)| *p)
}

/// v1 `bareModel`: `claude-opus-5-5[1m]` → `claude-opus-5-5`, `…-20261101` → `…`.
pub fn bare_model(id: &str) -> &str {
    let id = id.strip_suffix("[1m]").or_else(|| id.strip_suffix("[1M]")).unwrap_or(id);
    match id.rsplit_once('-') {
        Some((head, d)) if d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => id,
    }
}

fn agent<'a>(s: &'a Session, t: &'a Turn) -> &'a str {
    if t.agent.is_empty() { &s.agent } else { &t.agent }
}

fn numbered(t: &Turn) -> Option<(u64, u64)> {
    let st = t.stats.as_ref()?;
    Some((st.context_tokens.filter(|n| *n > 0)?, st.cache_ttl_ms.filter(|n| *n > 0)?))
}

/// The cache of a task idle with a known context, warm or cold; `None` when there is nothing to say.
/// `turns`: the task's turns, oldest first.
pub fn cold_cache(s: &Session, turns: &[Turn], at: i64) -> Option<Cold> {
    if s.resume_id.is_none() || matches!(s.state, SessionState::Running | SessionState::Waiting) {
        return None; // no conversation to resume: the reply starts fresh
    }
    if turns.iter().any(|t| t.status.is_live()) {
        return None;
    }
    let from = turns.iter().rposition(|t| numbered(t).is_some())?;
    let (tokens, ttl_ms) = numbered(&turns[from])?;
    let later = &turns[from + 1..];
    // a later turn that worked without a number moved the context on: don't guess; one that compacted
    // reports 0 and the task just shrank
    if later.iter().any(|t| t.stats.as_ref().is_some_and(|st| st.output_tokens.unwrap_or(0) > 0 || st.context_tokens == Some(0))) {
        return None;
    }
    let ended: Vec<&Turn> = turns[from..].iter().filter(|t| t.ended_at.is_some()).collect();
    let last = ended.last()?;
    if agent(s, &turns[from]) != s.agent || agent(s, last) != s.agent || tokens < LARGE {
        return None;
    }
    // any ended turn may have refreshed the cache, even one that did no work
    let used = ended.iter().filter_map(|t| t.ended_at).max()?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)] // a TTL in ms, far below 2^52
    let cold_at = used + (ttl_ms as f64 * GRACE) as i64;
    Some(Cold { tokens, ttl_ms, cold_at, cold: at >= cold_at })
}

/// v1 `mainModel`: the model that read the most (a context this large is the main thread's).
pub fn main_model(st: &TurnStats) -> String {
    let n = |v: &serde_json::Value, k: &str| v.get(k).and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    st.models
        .iter()
        .flatten()
        .map(|(id, v)| (bare_model(id).to_owned(), n(v, "input") + n(v, "cacheRead") + n(v, "cacheWrite")))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(id, _)| id)
        .unwrap_or_default()
}

/// Compact now, when this task can shrink before its cache lapses: only a harness that reports its cache's
/// TTL gets here (Claude today; no harness is named). Never for a subagent (the relay doesn't carry
/// `by: compact`), a turn held at a limit (it's live), or below [`COMPACT_MIN`].
pub fn compact_offer(s: &Session, turns: &[Turn], at: i64) -> Option<Offer> {
    if s.parent_id.is_some() {
        return None;
    }
    let c = cold_cache(s, turns, at)?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let until = c.cold_at - (c.ttl_ms as f64 * (GRACE - 1.0)) as i64;
    if c.tokens < COMPACT_MIN || at >= until {
        return None;
    }
    let st = turns.iter().rev().find(|t| numbered(t).is_some()).and_then(|t| t.stats.as_ref())?;
    let Some([input, read, output]) = price(&main_model(st)) else {
        return Some(Offer { tokens: c.tokens, compact: None, cold: None, until });
    };
    let write = input * if c.ttl_ms > 300_000 { WRITE_1H } else { WRITE_5M };
    #[allow(clippy::cast_precision_loss)]
    let tokens = c.tokens as f64;
    let compact = tokens.mul_add(read, COMPACT_OUTPUT.mul_add(output, COMPACT_WRITE * write)) / 1e6;
    Some(Offer { tokens: c.tokens, compact: Some(compact), cold: Some(tokens * write / 1e6), until })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const HOUR: u64 = 3_600_000;
    const HOUR_MS: i64 = 3_600_000;

    fn task(tokens: u64, model: &str, ended: i64) -> (Session, Vec<Turn>) {
        let s = Session { agent: "claude".into(), resume_id: Some("r".into()), state: SessionState::Review, ..Session::default() };
        let models = BTreeMap::from([(format!("{model}[1m]"), serde_json::json!({ "input": 10, "cacheRead": tokens }))]);
        let st = TurnStats { context_tokens: Some(tokens), cache_ttl_ms: Some(HOUR), output_tokens: Some(500), models: Some(models), ..TurnStats::default() };
        let t = Turn { agent: "claude".into(), status: TurnStatus::Done, ended_at: Some(ended), stats: Some(st), ..Turn::default() };
        (s, vec![t])
    }

    #[test]
    fn compact_prices_claude_fable_5_2() {
        assert_eq!(price("claude-fable-5-2"), Some([8.0, 0.2, 40.0]));
        assert_eq!(price("claude-fable-5-2[1m]"), Some([8.0, 0.2, 40.0]));
        assert_eq!(price("claude-fable-5-2-20261101"), Some([8.0, 0.2, 40.0]));
        let (s, turns) = task(480_000, "claude-fable-5-2", 0);
        let o = compact_offer(&s, &turns, 10 * 60_000).unwrap();
        // v1 compact.test.js: a cold re-read of 480k on Fable 5.2 at the 1 h write rate is 480k × $16/M
        assert_eq!(format!("{:.2}", o.cold.unwrap()), "7.68");
        assert_eq!(format!("{:.2}", o.compact.unwrap()), format!("{:.2}", (480_000.0 * 0.2 + 20_000.0 * 40.0 + 30_000.0 * 16.0) / 1e6));
    }

    #[test]
    fn the_cache_goes_cold_after_its_ttl_and_grace() {
        let (s, turns) = task(150_000, "claude-opus-5-5", 1_000);
        let c = cold_cache(&s, &turns, 1_000).unwrap();
        assert!(!c.cold && c.cold_at == 1_000 + 4_500_000);
        assert!(cold_cache(&s, &turns, 1_000 + 4_500_000).unwrap().cold);
        assert!(compact_offer(&s, &turns, 2_000).is_none(), "under 200k: no Compact now");
        let (small, t2) = task(50_000, "claude-opus-5-5", 0);
        assert!(cold_cache(&small, &t2, HOUR_MS * 2).is_none(), "a small task stays quiet");
    }

    #[test]
    fn compact_is_offered_until_the_ttl_not_the_grace() {
        let (s, turns) = task(300_000, "claude-opus-5-5", 0);
        let o = compact_offer(&s, &turns, 0).unwrap();
        assert_eq!(o.until, HOUR_MS);
        assert!(compact_offer(&s, &turns, HOUR_MS).is_none());
        let (s2, t2) = task(300_000, "some-new-model", 0);
        let o = compact_offer(&s2, &t2, 0).unwrap();
        assert_eq!((o.compact, o.cold), (None, None), "no price: tokens only");
    }

    #[test]
    fn a_later_turn_that_worked_without_a_number_is_not_guessed() {
        let (s, mut turns) = task(300_000, "claude-opus-5-5", 0);
        turns.push(Turn { agent: "claude".into(), status: TurnStatus::Done, ended_at: Some(5), stats: Some(TurnStats { output_tokens: Some(9), ..TurnStats::default() }), ..Turn::default() });
        assert!(cold_cache(&s, &turns, 0).is_none());
        turns.pop();
        turns.push(Turn { agent: "claude".into(), status: TurnStatus::Running, ..Turn::default() });
        assert!(cold_cache(&s, &turns, 0).is_none(), "a running turn");
        let mut sub = task(300_000, "claude-opus-5-5", 0);
        sub.0.parent_id = Some(wisp_runtime_api::SessionId::from("p"));
        assert!(compact_offer(&sub.0, &sub.1, 0).is_none(), "a subagent isn't compacted");
    }
}
