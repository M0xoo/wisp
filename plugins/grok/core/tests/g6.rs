//! Gate G6 for Grok: every recorded `grok --output-format streaming-messages-json` run parses as v1's adapter reported it, and
//! builds the argv v1 built for the same options (the fixtures' `meta.argv`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use serde_json::Value;
use wisp_grok_core::{GrokArgs, GrokParser, args};
use wisp_harness_kit::{NoDisk, RunPaths, golden};

const CWD: &str = "/tmp/wisp-g6-run";

fn dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn names() -> Vec<String> {
    let mut n: Vec<String> = std::fs::read_dir(dir()).unwrap().filter_map(Result::ok).filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".jsonl")).map(str::to_owned)).collect();
    n.sort();
    n
}

fn read(name: &str, ext: &str) -> String {
    std::fs::read_to_string(dir().join(format!("{name}.{ext}"))).unwrap_or_default()
}

fn meta(name: &str) -> Value {
    serde_json::from_str(&read(name, "meta.json")).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

#[test]
fn g6_every_recorded_grok_run_parses_as_v1_did() {
    let mut failed = Vec::new();
    let all = names();
    assert_eq!(all.len(), 7, "the 7 recorded runs");
    for name in &all {
        let m = meta(name);
        let o = &m["opts"];
        let _ = o;
        let mut p = GrokParser::new(RunPaths::same(CWD));
        if let Err(e) = golden::check(&mut p, CWD, &m, &read(name, "jsonl"), &read(name, "v1.json"), &mut NoDisk) {
            failed.push(format!("{name}: {e}"));
        }
    }
    eprintln!("G6 grok: {}/{} match v1", all.len() - failed.len(), all.len());
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn every_fixture_builds_v1s_argv() {
    for name in names() {
        let m = meta(&name);
        let o = &m["opts"];
        let rules = m["argv"][7].as_str().unwrap_or("").to_owned();
        let a = args(&GrokArgs {
            prompt_file: "PROMPT",
            mode: if o["mode"].is_string() { s(&o["mode"]) } else { "edits" },
            rules: &rules,
            model: s(&o["model"]),
            effort: s(&o["effort"]),
            resume_id: o["resumeId"].as_str(),
            agent_file: o["mcpServers"].is_object().then_some("AGENT"),
        });
        // v1's prompt and agent files had random temp names
        let want: Vec<String> = m["argv"].as_array().unwrap().iter().map(|x| match s(x) { p if p.ends_with("/prompt.md") => "PROMPT".to_owned(), p if p.ends_with("/wisp.md") => "AGENT".to_owned(), p => p.to_owned() }).collect();
        assert_eq!(a, want, "{name}");
    }
}
