//! The generic plan's goldens: each case's ops and its lines as the CLI prints them. Changing one is a
//! deliberate act: `UPDATE_GOLDENS=1 cargo test -p wisp-resources-core --test goldens`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use serde_json::{Value, json};
use wisp_resources_api::Resource;
use wisp_resources_core::plan::{lines, plan};

#[test]
fn plans_match_their_goldens() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(dir.join("plans.json")).unwrap()).unwrap();
    let update = std::env::var("UPDATE_GOLDENS").is_ok();
    let mut changed = Vec::new();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let cur: Vec<Resource> = serde_json::from_value(c["current"].clone()).unwrap();
        let want: Vec<Resource> = serde_json::from_value(c["desired"].clone()).unwrap();
        let (ops, same) = plan(&cur, &want, c["prune"].as_bool().unwrap_or(false));
        let shown: Vec<String> = lines(&ops).into_iter().map(|(m, l)| format!("{m} {l}")).collect();
        let got = serde_json::to_string_pretty(&json!({ "ops": ops, "unchanged": same, "lines": shown })).unwrap() + "\n";
        let file = dir.join("goldens").join(format!("{name}.json"));
        if update {
            std::fs::write(&file, &got).unwrap();
        } else if std::fs::read_to_string(&file).ok().as_deref() != Some(got.as_str()) {
            changed.push(name.to_owned());
        }
    }
    assert!(changed.is_empty(), "plan goldens differ for {changed:?} (UPDATE_GOLDENS=1 to accept)");
}
