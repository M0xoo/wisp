//! Gate G6 for Copilot: every recorded `copilot --output-format json` run parses as v1's adapter reported it, and
//! builds the argv v1 built for the same options (the fixtures' `meta.argv`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use serde_json::Value;
use std::collections::BTreeMap;

use wisp_copilot_core::{CopilotArgs, CopilotParser, args};
use wisp_harness_kit::{NoDisk, RunPaths, golden};

const CWD: &str = "/tmp/wisp-g6-run";
/// the id v1's recording gave a new session
const SESSION: &str = "11111111-2222-4333-8444-555555555555";

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
fn g6_every_recorded_copilot_run_parses_as_v1_did() {
    let mut failed = Vec::new();
    let all = names();
    assert_eq!(all.len(), 10, "the 10 recorded runs");
    for name in &all {
        let m = meta(name);
        let o = &m["opts"];
        let mut p = CopilotParser::new(RunPaths::same(CWD), o["resumeId"].as_str().unwrap_or(SESSION));
        if let Err(e) = golden::check(&mut p, CWD, &m, &read(name, "jsonl"), &read(name, "v1.json"), &mut NoDisk) {
            failed.push(format!("{name}: {e}"));
        }
    }
    eprintln!("G6 copilot: {}/{} match v1", all.len() - failed.len(), all.len());
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn every_fixture_builds_v1s_argv() {
    for name in names() {
        let m = meta(&name);
        let o = &m["opts"];
        let grants: Vec<String> = o["grants"].as_array().map(|g| g.iter().map(Value::to_string).collect()).unwrap_or_default();
        let mcp: BTreeMap<String, Value> = o["mcpServers"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        let a = CopilotArgs {
            mode: if o["mode"].is_string() { s(&o["mode"]) } else { "edits" },
            model: s(&o["model"]),
            effort: s(&o["effort"]),
            resume_id: o["resumeId"].as_str(),
            session: SESSION,
            usage_file: "USAGE",
            mcp_servers: Some(&mcp),
            grants: &grants,
            ..CopilotArgs::default()
        };
        // v1's usage file had a random temp name
        let want: Vec<String> = m["argv"].as_array().unwrap().iter().map(|x| if s(x).ends_with("/usage.json") { "USAGE".to_owned() } else { s(x).to_owned() }).collect();
        // the MCP config is JSON: compared as JSON (key order is the serializer's)
        let norm = |v: Vec<String>| v.into_iter().map(|x| serde_json::from_str::<Value>(&x).ok().filter(Value::is_object).map_or(x, |j| j.to_string())).collect::<Vec<_>>();
        assert_eq!(norm(args(&a)), norm(want), "{name}");
    }
}
