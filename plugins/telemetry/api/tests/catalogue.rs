//! ADR-0021's golden: the catalogue holds v1's 52 events, each with exactly v1's property keys
//! (fixtures/v1-events.json, extracted from v1's `track()` calls), so none can go missing again.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{Map, Value, json};
use wisp_telemetry_api::{catalogue, entry, ui_event};

#[test]
fn the_catalogue_is_v1s_52_events_with_their_properties() {
    let v1: Value = serde_json::from_str(include_str!("fixtures/v1-events.json")).unwrap();
    let want = v1["events"].as_object().unwrap();
    assert_eq!(want.len(), 52);
    assert_eq!(catalogue().len(), 52, "one entry per v1 event");
    for (name, props) in want {
        let e = entry(name).unwrap_or_else(|| panic!("{name} is missing from the catalogue"));
        let mut have = e.props.clone();
        have.sort();
        let want: Vec<String> = props.as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect();
        assert_eq!(have, want, "{name}'s properties");
        assert!(!e.owner.is_empty(), "{name} has an owner");
    }
}

#[test]
fn the_ui_may_send_only_its_events_and_values() {
    let p = |v: Value| v.as_object().cloned().unwrap_or_else(Map::new);
    assert_eq!(ui_event("getapp_opened", &p(json!({ "from": "button", "x": 1 }))), Some(p(json!({ "from": "button" }))));
    assert_eq!(ui_event("getapp_opened", &p(json!({ "from": "free text" }))), Some(Map::new()));
    assert_eq!(ui_event("turn_ended", &Map::new()), None, "a server event");
    assert_eq!(ui_event("nope", &Map::new()), None);
}
