//! Terminal goldens for every block type (ADR-0022): 80 and 40 columns, colour and plain. Changing one
//! is a deliberate act: `UPDATE_GOLDENS=1 cargo test -p wisp-cli-core --test goldens`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::format_push_string, clippy::items_after_statements)]

use std::path::{Path, PathBuf};

use serde_json::Value;
use wisp_cli_core::term::width;
use wisp_cli_core::{BUILTIN, Renderers, Style};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn samples() -> Vec<Value> {
    serde_json::from_str(&std::fs::read_to_string(dir().join("samples.json")).unwrap()).unwrap()
}

fn shown(lines: &[String]) -> String {
    // escapes made visible, so a diff of the golden reads
    lines.iter().map(|l| l.replace('\x1b', "␛")).collect::<Vec<_>>().join("\n")
}

#[test]
fn every_block_type_has_terminal_goldens() {
    let r = Renderers::builtin();
    let update = std::env::var("UPDATE_GOLDENS").is_ok();
    let mut changed = Vec::new();
    for b in samples() {
        let ty = b["type"].as_str().unwrap().to_owned();
        let mut text = String::new();
        for (name, st) in [("80 plain", Style::plain(80)), ("40 plain", Style::plain(40)), ("80 colour", Style::color(80)), ("40 colour", Style::color(40))] {
            let lines = r.block(&b, &st);
            assert!(!lines.is_empty(), "{ty} {name}: draws something");
            for l in &lines {
                assert!(width(l) <= st.width, "{ty} {name}: {l:?} is {} columns", width(l));
                assert!(!l.trim_start().starts_with('{'), "{ty} {name}: never raw JSON: {l}");
            }
            if !st.color {
                assert!(lines.iter().all(|l| !l.contains('\x1b')), "{ty} {name}: plain has no escapes");
            }
            text.push_str(&format!("── {name}\n{}\n", shown(&lines)));
        }
        let file = dir().join("goldens/blocks").join(format!("{ty}.txt"));
        if update {
            std::fs::write(&file, &text).unwrap();
        } else if std::fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
            changed.push(ty);
        }
    }
    assert!(changed.is_empty(), "goldens differ for {changed:?} (UPDATE_GOLDENS=1 to accept)");
}

#[test]
fn the_samples_cover_every_builtin_type_and_the_protocol_list() {
    let have: Vec<String> = samples().iter().map(|b| b["type"].as_str().unwrap().to_owned()).collect();
    for ty in BUILTIN {
        assert!(have.iter().any(|h| h == ty), "no sample for {ty}");
    }
    // the protocol's list (plugins/runtime/core BUILTIN_BLOCKS) is this list
    let src = std::fs::read_to_string(dir().join("../../../runtime/core/src/blocks/check.rs")).unwrap();
    let start = src.find("pub const BUILTIN_BLOCKS").unwrap();
    let list = &src[start..start + src[start..].find("];").unwrap()];
    let theirs: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
    assert_eq!(theirs, BUILTIN, "plugins/runtime/core's BUILTIN_BLOCKS and the terminal renderers' list");
}

#[test]
fn an_unknown_type_says_update_wisp_and_a_contributed_renderer_wins() {
    let r = Renderers::builtin();
    let b: Value = serde_json::json!({ "type": "sparkle", "title": "Sparkles", "summary": "three" });
    let got = r.block(&b, &Style::plain(40));
    assert!(got.iter().any(|l| l.contains("update wisp")), "{got:?}");
    struct Sparkle;
    impl wisp_cli_api::TermBlock for Sparkle {
        fn types(&self) -> &[&str] {
            &["sparkle"]
        }
        fn render(&self, _: &Value, _: &Style) -> Vec<String> {
            vec!["✨✨✨".into()]
        }
    }
    let mut r = r;
    r.add(std::sync::Arc::new(Sparkle));
    assert_eq!(r.block(&b, &Style::plain(40)), ["✨✨✨"]);
}
