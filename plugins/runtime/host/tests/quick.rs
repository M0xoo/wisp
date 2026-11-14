//! `runtime.quick` (v1 quick.js): a side run's steps come back with its answer, as a turn's activity records them,
//! so a goal check's page shows the judge's tool calls, not only what it said.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::rig;
use wisp_runtime_api::commands::QuickArgs;
use wisp_runtime_api::model::{Activity, ToolKind};

#[tokio::test(flavor = "multi_thread")]
async fn a_quick_run_returns_its_tool_steps() {
    let dir = std::env::temp_dir().join(format!("wisp-quick-steps-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let r = rig().await;
    let q = QuickArgs { prompt: "judge it".into(), cwd: dir.display().to_string(), pick: None, timeout_ms: None, json: false };
    let out = r.rt.quick(q).await.unwrap();
    assert!(out.text.contains("done: judge it"), "{}", out.text);
    let tool = out.activity.iter().find_map(|a| match a {
        Activity::Tool { tool, label, call_id, .. } => Some((*tool, label.as_str(), call_id.as_deref())),
        _ => None,
    });
    assert_eq!(tool, Some((ToolKind::Run, "Run tests", Some("c1"))), "{:?}", out.activity);
    assert!(
        out.activity.iter().any(|a| matches!(a, Activity::ToolOutput { call_id, text, .. } if call_id == "c1" && text == "ok")),
        "its output too: {:?}",
        out.activity
    );
    assert!(out.activity.iter().any(|a| matches!(a, Activity::Text { .. })), "and its text: {:?}", out.activity);
    std::fs::remove_dir_all(&dir).ok();
}
