//! Shared by the telemetry-core tests: fixed inputs and the golden-file check.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::doc_markdown,
    clippy::missing_panics_doc
)]

use std::path::PathBuf;

use serde_json::Value;
use wisp_telemetry_core::{Common, Props, ScrubOptions, Telemetry, env::Env};

pub const HOME: &str = "/Users/ada";
pub const ROOT: &str = "/opt/wisp";
pub const NOW: i64 = 1_794_009_600_000; // 2026-11-07T00:00:00.000Z

pub fn common() -> Props {
    Common {
        version: "2.0.0".into(),
        os: "darwin".into(),
        os_release: Some("24.6.0".into()),
        arch: "arm64".into(),
        node: None,
        shell: "browser".into(),
    }
    .props()
}

pub fn scrub() -> ScrubOptions {
    ScrubOptions { home: HOME.into(), root: ROOT.into() }
}

pub fn env(pairs: &[(&str, &str)]) -> Env {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

pub fn telemetry(pairs: &[(&str, &str)]) -> Telemetry {
    Telemetry::new(env(pairs), common(), scrub())
}

pub fn id() -> String {
    "00000000-0000-4000-8000-000000000001".into()
}

/// Compares `got` with `goldens/<name>.json`. `WISP_UPDATE_GOLDENS=1` rewrites it: a deliberate act,
/// reviewed in the PR (these are PostHog's dashboards).
pub fn golden(name: &str, got: &Value) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens").join(format!("{name}.json"));
    let text = serde_json::to_string_pretty(got).unwrap() + "\n";
    if std::env::var("WISP_UPDATE_GOLDENS").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let want =
        std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run with WISP_UPDATE_GOLDENS=1 once", path.display()));
    assert_eq!(text, want, "golden {name} changed");
}

pub fn props(e: &Value) -> &serde_json::Map<String, Value> {
    e["properties"].as_object().unwrap()
}
