//! v1 #775: a result that comes while Claude Code's background subagents still work says how many, so the turn waits
//! for their reports (shells left running don't count: a dev server is a finished task that left something up).
#![allow(clippy::unwrap_used)]

use wisp_claude_core::{ClaudeOptions, ClaudeParser};
use wisp_harness_kit::{Exit, HarnessEvent, NoDisk, RunPaths, replay};

const CWD: &str = "/tmp/wisp-subagents";

fn results(lines: &[&str]) -> Vec<(Option<u64>, Option<u64>)> {
    let mut parser = ClaudeParser::new(ClaudeOptions { paths: RunPaths::same(CWD), prior: None, unknown_prior: false });
    let exit = Exit { code: Some(0), signal: None, stderr: String::new(), stopped: false, stop_requested: false };
    replay(&mut parser, lines, &exit, &mut NoDisk, |i| i64::try_from(i).unwrap_or(0))
        .into_iter()
        .filter_map(|e| match e {
            HarnessEvent::Result(r) => Some((r.background, r.background_agents)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_result_while_subagents_work_counts_them_and_shells_dont() {
    let init = r#"{"type":"system","subtype":"init","session_id":"s1","claude_code_version":"9.9.9"}"#;
    let tasks = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a1","task_type":"local_agent","description":"Review the diff"},{"task_id":"b1","task_type":"local_bash","description":"npm run dev"}],"session_id":"s1"}"#;
    let early = r#"{"type":"result","subtype":"success","is_error":false,"result":"Done, I think.","session_id":"s1"}"#;
    let gone = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"npm run dev"}],"session_id":"s1"}"#;
    let last = r#"{"type":"result","subtype":"success","is_error":false,"result":"The review found nothing.","session_id":"s1"}"#;
    // two background tasks, one a subagent; once it reported, only the dev server is left (0, said as v1 says it)
    assert_eq!(results(&[init, tasks, early, gone, last]), vec![(Some(2), Some(1)), (Some(1), Some(0))]);
    // task_started's own task_type counts too (CLI versions that only send the edges)
    let started = r#"{"type":"system","subtype":"task_started","task_id":"a2","task_type":"local_agent","description":"Write tests","is_backgrounded":true,"session_id":"s1"}"#;
    assert_eq!(results(&[init, started, early]), vec![(Some(1), Some(1))]);
}
