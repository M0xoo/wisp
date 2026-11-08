//! `cli.catalogue`: every command the caller may run, with its manifest title and argument type, and
//! nothing its capability set refuses (ADR-0022: "the user's capability set applies").
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{Value, json};
use wisp_cli::CliPlugin;
use wisp_kernel::{Caller, Command, Manifest, Plugin, Result, Setup};
use wisp_testkit::TestApp;

struct Add;
impl Command for Add {
    const ID: &'static str = "notes.add";
    const PERMISSION: Option<&'static str> = Some("notes:write");
    type Args = Value;
    type Out = Value;
    fn args_ts() -> Option<String> {
        Some("{ \n/**\n * what to note\n */\ntext: string, pinned?: boolean, }".into())
    }
}
struct Wipe;
impl Command for Wipe {
    const ID: &'static str = "notes.wipe";
    const PERMISSION: Option<&'static str> = Some("plugins:manage");
    type Args = Value;
    type Out = Value;
}

struct Notes;
impl Plugin for Notes {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.notes", "version": "1.0.0", "api": "^1",
            "contributes": { "commands": [{ "id": "notes.add", "title": "Add a note" }, { "id": "notes.wipe", "title": "Wipe them" }] } }))
        .unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Add, _, _>(|_, _, a| async move { Ok(a) });
        s.command::<Wipe, _, _>(|_, _, _| async move { Ok(json!({})) });
        Ok(())
    }
}

#[tokio::test]
async fn the_catalogue_has_titles_and_argument_types_and_follows_the_capability_set() {
    let k = TestApp::new().with(CliPlugin).with(Notes).start().await;
    let all = k.call(Caller::user(), "cli.catalogue", json!({})).await.unwrap();
    let ids: Vec<&str> = all.as_array().unwrap().iter().filter_map(|c| c["id"].as_str()).collect();
    assert!(ids.contains(&"notes.add") && ids.contains(&"notes.wipe") && ids.contains(&"cli.catalogue"), "{ids:?}");
    let add = all.as_array().unwrap().iter().find(|c| c["id"] == "notes.add").unwrap();
    assert_eq!(add["title"], "Add a note");
    assert_eq!(add["plugin"], "acme.notes");
    assert!(add["args"].as_str().unwrap().contains("what to note"));
    // an agent's token may run neither: the catalogue it reads says so
    let agent = k.call(Caller::agent("S1", false), "cli.catalogue", json!({})).await;
    if let Ok(list) = agent {
        let ids: Vec<&str> = list.as_array().unwrap().iter().filter_map(|c| c["id"].as_str()).collect();
        assert!(!ids.contains(&"notes.wipe"), "{ids:?}");
    }
}
