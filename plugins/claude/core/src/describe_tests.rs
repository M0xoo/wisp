//! describe.rs's tests.
use super::*;
use serde_json::json;

fn p() -> RunPaths {
    RunPaths::new("/w", "/private/w")
}

#[test]
fn patterns_compile() {
    assert!(GITHUB.compiles() && SLASH.compiles());
}

#[test]
fn labels() {
    let d = |n: &str, i: Value| describe_tool(n, &i, &p()).label;
    assert_eq!(d("Bash", json!({"command": "x", "description": "Run  the\ntests"})), "Run the tests");
    assert_eq!(d("Bash", json!({"command": "curl -s https://example.com"})), "Fetching example.com");
    assert_eq!(d("mcp__github__get_issue", json!({})), "Using github · get_issue");
    assert_eq!(d("mcp__wisp__wisp_crew_add", json!({"member": "Ada"})), "Adding Ada to your crew");
    assert_eq!(d("mcp__wisp__delegate", json!({"tasks": [{"subagent": "a"}, {"subagent": "b"}, {"subagent": "a"}]})), "Delegating to a, b");
    assert_eq!(d("mcp__wisp__wisp_save", json!({"path": "/x/y/report.md"})), "Saving report.md to My Stuff");
    assert_eq!(d("mcp__wisp__wisp_pr", json!({"pr": "https://github.com/o/r/pull/1"})), "Attaching PR o/r/pull/1");
    assert_eq!(d("TodoWrite", json!({"todos": [{"status": "in_progress", "content": "Fix it"}]})), "Fix it");
}

#[test]
fn edge_7_both_spellings_of_the_folder() {
    assert_eq!(describe_tool("Read", &json!({"file_path": "/private/w/a.js"}), &p()).file.as_deref(), Some("a.js"));
    assert_eq!(describe_tool("Read", &json!({"file_path": "/w/a.js"}), &p()).file.as_deref(), Some("a.js"));
}

#[test]
fn rules_and_details() {
    assert_eq!(rule_of("Bash", &json!({"command": "npm publish"})), "Bash(npm publish)");
    assert_eq!(rule_of("WebFetch", &json!({})), "WebFetch");
    assert_eq!(detail_of("Edit", &json!({"file_path": "/w/src/a.ts"}), &p()), "src/a.ts");
    assert_eq!(action_of("Write", &json!({"file_path": "/w/a"}), &p()), "write a");
    assert_eq!(action_of("Bash", &json!({"command": "ls"}), &p()), "run `ls`");
}

#[test]
fn edge_6_write_reads_the_file_before_the_cli_does() {
    let step = capture_change("Write", &json!({"file_path": "a.txt", "content": "new"}), &p());
    assert_eq!(step, Some(Out::Io(IoStep::WriteBefore { abs: "/w/a.txt".into(), file: "a.txt".into(), after: "new".into() })));
}
