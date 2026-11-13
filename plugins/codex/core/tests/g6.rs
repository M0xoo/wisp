//! Gate G6 for Codex: every recorded `codex exec --json` run parses as v1's adapter reported it, and
//! builds the argv v1 built for the same options (the fixtures' `meta.argv`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use wisp_codex_core::{CodexArgs, CodexOptions, CodexParser, args};
use wisp_harness_kit::{NoDisk, RunPaths, golden};

const CWD: &str = "/tmp/wisp-g6-run";

fn dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn names() -> Vec<String> {
    let mut n: Vec<String> = std::fs::read_dir(dir())
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".jsonl")).map(str::to_owned))
        .collect();
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
fn g6_every_recorded_codex_run_parses_as_v1_did() {
    let mut failed = Vec::new();
    let all = names();
    assert_eq!(all.len(), 20, "the 20 recorded runs");
    for name in &all {
        let m = meta(name);
        let o = &m["opts"];
        let mut p = CodexParser::new(CodexOptions {
            paths: RunPaths::same(CWD),
            resume_id: o["resumeId"].as_str().map(str::to_owned),
            fork: o["fork"].as_bool().unwrap_or(false),
            prior: o.get("prior").cloned(),
        });
        if let Err(e) = golden::check(&mut p, CWD, &m, &read(name, "jsonl"), &read(name, "v1.json"), &mut NoDisk) {
            failed.push(format!("{name}: {e}"));
        }
    }
    eprintln!("G6 codex: {}/{} match v1", all.len() - failed.len(), all.len());
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn every_fixture_builds_v1s_argv() {
    let none = BTreeMap::new();
    for name in names() {
        let m = meta(&name);
        let o = &m["opts"];
        let dirs: Vec<String> = o["dirs"].as_array().map(|a| a.iter().map(|d| s(d).to_owned()).collect()).unwrap_or_default();
        let lean = o["lean"].as_bool().unwrap_or(false);
        let a = CodexArgs {
            mode: if o["mode"].is_string() { s(&o["mode"]) } else { "edits" },
            model: s(&o["model"]),
            effort: s(&o["effort"]),
            dirs: &dirs,
            resume_id: o["resumeId"].as_str(),
            fork: o["fork"].as_bool().unwrap_or(false),
            capped: o["capped"].as_bool().unwrap_or(false),
            lean_base: lean.then_some("BASE"),
            mcp_servers: Some(&none),
            ..CodexArgs::default()
        };
        let want: Vec<String> = m["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| {
                let x = s(x);
                // v1's lean base file had a random temp name
                if x.starts_with("model_instructions_file=") { "model_instructions_file=\"BASE\"".to_owned() } else { x.to_owned() }
            })
            .collect();
        assert_eq!(args(&a), want, "{name}");
    }
}
