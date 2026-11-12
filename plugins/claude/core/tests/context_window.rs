//! v1 #785: a result says how much the main thread's model can hold (`stats.contextWindow`), from modelUsage, so the
//! task shows how full its context is.
#![allow(clippy::unwrap_used)]

use serde_json::Value;
use wisp_claude_core::{ClaudeOptions, ClaudeParser};
use wisp_harness_kit::{Exit, HarnessEvent, NoDisk, RunPaths, replay};

fn window(lines: &[&str]) -> Option<Value> {
    let mut parser = ClaudeParser::new(ClaudeOptions { paths: RunPaths::same("/tmp/wisp-ctx"), prior: None, unknown_prior: false });
    let exit = Exit { code: Some(0), signal: None, stderr: String::new(), stopped: false, stop_requested: false };
    replay(&mut parser, lines, &exit, &mut NoDisk, |i| i64::try_from(i).unwrap_or(0))
        .into_iter()
        .find_map(|e| match e {
            HarnessEvent::Result(r) => Some(r.stats.and_then(|s| s.extra.get("contextWindow").cloned())),
            _ => None,
        })
        .flatten()
}

fn result(usage: &str) -> String {
    format!(r#"{{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","usage":{{"output_tokens":5}},"modelUsage":{usage}}}"#)
}

#[test]
fn the_context_window_is_the_main_threads_models_from_model_usage_v1_785() {
    let usage = r#"{"claude-opus-5-5":{"inputTokens":900,"outputTokens":5,"contextWindow":1000000},"claude-haiku-5-5":{"inputTokens":90000,"outputTokens":5,"contextWindow":200000}}"#;
    let init = |model: &str| format!(r#"{{"type":"system","subtype":"init","session_id":"s1","model":"{model}"}}"#);
    let r = result(usage);
    // the init's model, even when a subagent read more
    assert_eq!(window(&[&init("claude-opus-5-5"), &r]), Some(1_000_000.into()));
    // the [1m] suffix is the same model
    assert_eq!(window(&[&init("claude-opus-5-5[1m]"), &r]), Some(1_000_000.into()));
    // no init model: the model that read most
    assert_eq!(window(&[r#"{"type":"system","subtype":"init","session_id":"s1"}"#, &r]), Some(200_000.into()));
    // an old CLI without contextWindow: unknown, nothing said
    let old = result(r#"{"claude-opus-5-5":{"inputTokens":1,"outputTokens":5}}"#);
    assert_eq!(window(&[&init("claude-opus-5-5"), &old]), None);
}
