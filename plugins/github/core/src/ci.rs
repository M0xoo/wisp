//! CI as a trigger source (ADR-0043: `ci.failed`, `ci.passed`), sans-IO: the `gh run list` arguments, its JSON
//! read into events past the cursor, and a rate limit told from a failure (a 403 rate limit waits for its reset
//! and isn't counted as a failed poll).

use serde_json::{Value, json};
use wisp_automations_api::TriggerEvent;

/// `gh run list` for a branch (empty: every branch).
pub fn run_list_args(branch: &str) -> Vec<String> {
    let mut a: Vec<String> = ["run", "list", "--limit", "20", "--json", "databaseId,conclusion,status,headBranch,headSha,workflowName,displayTitle,url,createdAt"].iter().map(|s| (*s).to_owned()).collect();
    if !branch.is_empty() {
        a.push("--branch".into());
        a.push(branch.to_owned());
    }
    a
}

/// The runs that finished with `on`'s conclusion since `cursor`, oldest first, and the new cursor: the highest run
/// id below every run still going (a run that's still going is read again until it ends; the engine's dedupe key
/// `ci:<id>` keeps a run from firing twice). The first poll only sets the cursor: a trigger made today doesn't
/// fire on last week's failures.
pub fn ci_events(on: &str, stdout: &str, cursor: &Value) -> Result<(Vec<TriggerEvent>, Value), String> {
    let runs: Vec<Value> = serde_json::from_str(stdout).map_err(|e| format!("gh run list said something unexpected: {e}"))?;
    let id = |r: &Value| r.get("databaseId").and_then(Value::as_u64).unwrap_or(0);
    let going = runs.iter().filter(|r| r.get("status").and_then(Value::as_str) != Some("completed")).map(id).min();
    let top = going.map_or_else(|| runs.iter().map(id).max().unwrap_or(0), |g| g.saturating_sub(1));
    let Some(seen) = cursor.as_u64() else {
        return Ok((Vec::new(), json!(top)));
    };
    let want = if on == "ci.passed" { "success" } else { "failure" };
    let mut out: Vec<TriggerEvent> = runs
        .iter()
        .filter(|r| id(r) > seen && r.get("status").and_then(Value::as_str) == Some("completed"))
        .filter(|r| {
            let c = r.get("conclusion").and_then(Value::as_str).unwrap_or("");
            c == want || (want == "failure" && (c == "timed_out" || c == "startup_failure"))
        })
        .map(|r| {
            let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
            TriggerEvent { on: on.to_owned(), key: format!("ci:{}", id(r)), at: 0, summary: format!("{} {} on {}: {}", s("workflowName"), if want == "success" { "passed" } else { "failed" }, s("headBranch"), s("displayTitle")), payload: json!({ "branch": s("headBranch"), "workflow": s("workflowName"), "sha": s("headSha"), "url": s("url"), "title": s("displayTitle"), "conclusion": s("conclusion"), "run": id(r) }), ..TriggerEvent::default() }
        })
        .collect();
    out.sort_by_key(|e| e.payload["run"].as_u64());
    Ok((out, json!(top.max(seen))))
}

/// gh's stderr for a rate limit (HTTP 403/429 "API rate limit exceeded", or a secondary rate limit).
pub fn rate_limited(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("rate limit") && (s.contains("403") || s.contains("429") || s.contains("exceeded"))
}

/// `gh api rate_limit`'s reset (s) as ms.
pub fn reset_at(stdout: &str) -> Option<i64> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    v.pointer("/resources/core/reset").or_else(|| v.pointer("/rate/reset")).and_then(Value::as_i64).map(|s| s * 1_000)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::assert_is_empty)]
mod tests {
    use super::*;

    fn run(id: u64, status: &str, conclusion: &str) -> Value {
        json!({ "databaseId": id, "status": status, "conclusion": conclusion, "headBranch": "main", "workflowName": "CI", "displayTitle": "fix it", "url": "u", "headSha": "abc" })
    }

    #[test]
    fn ci_runs_past_the_cursor_become_events() {
        let list = json!([run(5, "completed", "failure"), run(4, "completed", "success"), run(3, "completed", "failure")]).to_string();
        let (first, c) = ci_events("ci.failed", &list, &Value::Null).unwrap();
        assert!(first.is_empty(), "the first poll only sets the cursor");
        assert_eq!(c, json!(5));
        let list = json!([run(8, "in_progress", ""), run(7, "completed", "failure"), run(6, "completed", "success"), run(5, "completed", "failure")]).to_string();
        let (evs, c) = ci_events("ci.failed", &list, &json!(5)).unwrap();
        assert_eq!(evs.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["ci:7"]);
        assert_eq!(evs[0].payload["branch"], "main");
        assert_eq!(c, json!(7), "run 8 is still going: it's read again next time");
        // run 8 fails later: it fires then
        let later = json!([run(8, "completed", "failure"), run(7, "completed", "failure")]).to_string();
        let (evs, c) = ci_events("ci.failed", &later, &c).unwrap();
        assert_eq!((evs.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), c), (vec!["ci:8"], json!(8)));
        let (passed, _) = ci_events("ci.passed", &list, &json!(5)).unwrap();
        // (7 completed above the cursor 5 is read again until the cursor passes it: dedupe holds it to once)
        assert_eq!(passed.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["ci:6"]);
        assert!(ci_events("ci.failed", "not json", &json!(1)).is_err());
    }

    #[test]
    fn a_rate_limit_is_told_from_a_failure() {
        assert!(rate_limited("HTTP 403: API rate limit exceeded for user ID 1."));
        assert!(rate_limited("You have exceeded a secondary rate limit"));
        assert!(!rate_limited("HTTP 404: Not Found"));
        assert_eq!(reset_at(r#"{"resources":{"core":{"reset":1700000000}}}"#), Some(1_700_000_000_000));
    }
}
