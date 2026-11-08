//! The agent protocol is a contract (plan §6.9, AGENTS.md "goldens"): real answers parse and render as
//! pinned, and the system prompt is pinned in its three main shapes. `UPDATE_GOLDENS=1` rewrites them:
//! changing one is a deliberate act in the PR.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use serde_json::{Value, json};
use wisp_runtime_core::blocks::{blocks_to_markdown, parse, render::Context};
use wisp_runtime_core::prompt::subagents::SUBAGENT_ASK;
use wisp_runtime_core::prompt::{SystemOpts, system_prompt};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens")
}

fn golden(name: &str, actual: &str) {
    let file = dir().join(name);
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") || !file.exists() {
        std::fs::write(&file, actual).unwrap();
    }
    let want = std::fs::read_to_string(&file).unwrap();
    assert!(
        want == actual,
        "{name} changed: run with UPDATE_GOLDENS=1 if that is meant\n--- want\n{want}\n--- got\n{actual}"
    );
}

fn inputs() -> Vec<String> {
    serde_json::from_str(&std::fs::read_to_string(dir().join("blocks-real.json")).unwrap()).unwrap()
}

/// The TS port's parse result for one answer, as its JSON (undefined fields left out).
fn parsed_json(text: &str) -> Value {
    let p = parse(text);
    let mut o = json!({ "blocks": p.blocks });
    if let Some(n) = p.notes {
        o["notes"] = json!(n);
    }
    if let Some(t) = p.topic {
        o["topic"] = json!(t);
    }
    if p.fallback {
        o["fallback"] = json!(true);
    }
    o
}

#[test]
fn real_answers_parse_as_pinned() {
    let inputs = inputs();
    assert!(inputs.len() >= 15);
    let want: Vec<Value> = serde_json::from_str(
        &std::fs::read_to_string(dir().join("blocks-real.parsed.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(want.len(), inputs.len());
    for (i, (t, w)) in inputs.iter().zip(&want).enumerate() {
        assert_eq!(&parsed_json(t), w, "answer {i}");
    }
}

#[test]
fn real_answers_render_to_markdown_as_pinned() {
    let md: Vec<String> = inputs()
        .iter()
        .enumerate()
        .map(|(i, t)| {
            format!(
                "<!-- answer {i} -->\n{}",
                blocks_to_markdown(&parse(t).blocks, &Context::default())
            )
        })
        .collect();
    golden("blocks-real.md", &format!("{}\n", md.join("\n\n")));
}

#[test]
fn the_system_prompt_is_pinned_in_its_three_main_shapes() {
    golden("system-prompt.txt", &system_prompt(&SystemOpts::default()));
    golden(
        "system-prompt-plain.txt",
        &system_prompt(&SystemOpts {
            blocks: false,
            ..SystemOpts::default()
        }),
    );
    golden(
        "system-prompt-subagent.txt",
        &system_prompt(&SystemOpts {
            ask: Some(SUBAGENT_ASK.to_owned()),
            ..SystemOpts::default()
        }),
    );
}

#[test]
fn every_built_in_block_type_the_prompt_documents_appears_in_a_golden_answer() {
    let seen: Vec<String> = inputs()
        .iter()
        .flat_map(|t| {
            parse(t)
                .blocks
                .into_iter()
                .filter_map(|b| b.get("type").and_then(Value::as_str).map(str::to_owned))
        })
        .collect();
    for ty in wisp_runtime_core::blocks::BUILTIN_BLOCKS {
        assert!(seen.iter().any(|s| s == ty), "{ty}");
    }
}
