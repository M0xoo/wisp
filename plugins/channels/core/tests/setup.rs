//! Settings → Phone's pure rules (F-chan-13): v1's checks before saving, what each channel still needs, and the
//! state it shows.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::{Map, Value, json};
use wisp_channels_api::SetupState;
use wisp_channels_core::setup::{
    Health, check_secret, check_setting, fresh_code, fresh_topic, missing, secret_fields, setting_fields, state,
};

fn map(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

#[test]
fn every_phone_channel_has_its_fields_and_a_secret_is_never_a_plain_setting() {
    for t in wisp_channels_api::PHONE_ORDER {
        for (s, _) in setting_fields(t) {
            assert!(!secret_fields(t).contains(s), "{t}.{s} is a secret and a setting");
        }
    }
    assert_eq!(secret_fields("slack"), ["appToken", "botToken", "signingSecret"]);
    assert!(secret_fields("github").is_empty() && secret_fields("email").is_empty());
}

#[test]
fn a_secret_is_checked_as_v1_checked_it_and_never_names_another_secret() {
    assert_eq!(check_secret("slack", "botToken", "nope").unwrap_err(), "The bot token starts with xoxb-.");
    assert_eq!(check_secret("slack", "appToken", "xoxb-1").unwrap_err(), "The app-level token starts with xapp-.");
    assert!(check_secret("slack", "botToken", &["xoxb", "-1-2-abc"].concat()).is_ok());
    assert!(check_secret("discord", "publicKey", &"ab".repeat(32)).is_ok());
    assert!(check_secret("discord", "publicKey", "abc").unwrap_err().contains("64 hex"));
    assert!(check_secret("discord", "token", "a.b.c").is_ok() && check_secret("discord", "token", "abc").is_err());
    assert!(check_secret("telegram", "token", "123456:ABCDEFGHIJ").is_ok());
    assert!(check_secret("telegram", "token", "not a token").is_err(), "spaces");
    assert!(check_secret("telegram", "token", "${secret:channels/sign}").unwrap_err().contains("not a reference"));
    assert!(check_secret("ntfy", "botToken", "x").unwrap_err().contains("no secret named botToken"));
    assert!(check_secret("slack", "botToken", "  ").is_ok(), "empty: removed");
}

#[test]
fn a_setting_is_checked_and_kept_tidy() {
    assert_eq!(check_setting("ntfy", "topic", &json!("wisp-123_ab")).unwrap(), json!("wisp-123_ab"));
    assert_eq!(check_setting("ntfy", "topic", &json!("a b")).unwrap_err(), "ntfy topic: letters, digits, - and _ only");
    assert_eq!(check_setting("ntfy", "topic", &json!("x".repeat(65))).unwrap_err(), "ntfy topic: letters, digits, - and _ only");
    assert_eq!(check_setting("ntfy", "server", &json!("ftp://x")).unwrap_err(), "ntfy server must be an http(s) URL");
    assert_eq!(check_setting("ntfy", "server", &json!(" https://ntfy.example.com ")).unwrap(), json!("https://ntfy.example.com"));
    assert_eq!(check_setting("email", "sender", &json!(" Ada@Example.COM ")).unwrap(), json!("ada@example.com"));
    assert!(check_setting("email", "sender", &json!("ada@localhost")).is_err());
    assert_eq!(check_setting("github", "publicReports", &json!(true)).unwrap(), json!(true));
    assert!(check_setting("github", "publicReports", &json!("yes")).is_err());
    assert!(check_setting("telegram", "topic", &json!("x")).unwrap_err().contains("no setting named topic"));
    assert!(check_setting("ntfy", "topic", &json!("${secret:a}")).is_err());
}

#[test]
fn what_each_channel_still_needs_here_and_on_a_cloud_computer() {
    let none = Map::new();
    assert_eq!(missing("ntfy", false, &[], &none), ["topic"]);
    assert_eq!(missing("ntfy", false, &[], &map(&json!({ "topic": "wisp-1" }))), Vec::<&str>::new());
    assert_eq!(missing("telegram", false, &[], &none), ["token"]);
    assert_eq!(missing("slack", false, &["botToken"], &none), ["appToken"]);
    assert_eq!(missing("slack", true, &["appToken"], &none), ["signingSecret", "botToken"], "a cloud computer: Slack calls in");
    assert_eq!(missing("discord", false, &["token"], &none), Vec::<&str>::new());
    assert_eq!(missing("discord", true, &["token"], &none), ["publicKey"]);
    assert_eq!(missing("github", false, &[], &none), Vec::<&str>::new());
    assert_eq!(missing("email", false, &[], &none), ["cloud"], "email only on a cloud computer");
    assert_eq!(missing("email", true, &[], &map(&json!({ "sender": " " }))), ["sender"]);
}

#[test]
fn the_state_settings_shows() {
    let up = Health { running: true, ok: Some(true), unlinked: false };
    assert_eq!(state(false, &["token"], up), SetupState::Off, "off wins");
    assert_eq!(state(true, &["token"], up), SetupState::Incomplete);
    assert_eq!(state(true, &[], Health { ok: Some(false), ..up }), SetupState::Failing);
    assert_eq!(state(true, &[], Health { ok: None, ..up }), SetupState::Checking);
    assert_eq!(state(true, &[], Health { running: false, ..up }), SetupState::Checking);
    assert_eq!(state(true, &[], Health { unlinked: true, ..up }), SetupState::Linking);
    assert_eq!(state(true, &[], up), SetupState::Connected);
}

#[test]
fn a_fresh_topic_and_code_have_v1s_shape() {
    for r in [0, 1, u64::MAX, 123_456_789_012_345_678] {
        let t = fresh_topic(r);
        assert!(t.len() == 19 && t.starts_with("wisp-") && t[5..].bytes().all(|b| b.is_ascii_digit()), "{t}");
        let c = fresh_code(r);
        assert!(c.len() == 6 && !c.starts_with('0'), "{c}");
        assert!(check_setting("ntfy", "topic", &json!(t)).is_ok());
    }
}
