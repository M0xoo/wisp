use serde_json::json;
use wisp_machines_api::{PeerState, RemoteInfo};

use super::*;

fn args(v: Value) -> AddArgs {
    serde_json::from_value(v).unwrap_or_default()
}

fn row() -> PeerRow {
    PeerRow { id: "ab12cd".into(), peer: None, name: "devbox".into(), transport: "ssh".into(), address: "me@devbox".into(), port: 4477, command: String::new(), auto_connect: true, added_at: 7, data: BTreeMap::new() }
}

#[test]
fn ssh_input_is_checked_and_falls_back_to_the_row() {
    let c = clean_ssh(&args(json!({"address": "me@devbox"})), None);
    assert_eq!(c, Ok(Cleaned { name: Some("devbox".into()), address: Some("me@devbox".into()), port: Some(4477), command: Some(String::new()), auto_connect: Some(true) }));
    assert_eq!(clean_ssh(&args(json!({"address": "-oProxyCommand=touch /tmp/x"})), None), Err("SSH host: user@host, a host name, or a Host from ~/.ssh/config.".into()));
    assert!(clean_ssh(&args(json!({"address": "a b"})), None).is_err());
    for bad in [json!(0), json!(70000), json!(1.5), json!("x"), json!(true)] {
        assert_eq!(clean_ssh(&args(json!({"address": "box", "port": bad})), None), Err("Port: a number from 1 to 65535.".into()), "{bad}");
    }
    assert_eq!(clean_ssh(&args(json!({"address": "box", "port": "4555"})), None).ok().and_then(|c| c.port), Some(4555));
    let prev = PeerRow { port: 4600, command: "wisp".into(), ..row() };
    let c = clean_ssh(&args(json!({"name": "  a name that is far too long for a card, really  "})), Some(&prev)).unwrap_or_default();
    assert_eq!(c.name.as_deref(), Some("a name that is far too long for a card, "));
    assert_eq!((c.port, c.command.as_deref(), c.address.as_deref()), (Some(4600), Some("wisp"), Some("me@devbox")));
    assert_eq!(clean_ssh(&args(json!({"autoConnect": false})), Some(&prev)).ok().and_then(|c| c.auto_connect), Some(false));
}

#[test]
fn a_grid_peer_changes_only_its_name_and_auto_connect() {
    let prev = PeerRow { transport: "grid".into(), name: "wisp Cloud".into(), ..row() };
    let c = clean_grid(&args(json!({"name": " ", "address": "evil", "autoConnect": false})), &prev);
    assert_eq!(c, Cleaned { name: Some("wisp Cloud".into()), auto_connect: Some(false), ..Cleaned::default() });
}

#[test]
fn a_second_accounts_same_named_computer_gets_its_handle() {
    assert_eq!(grid_label(Some("wisp Cloud"), Some("mo"), "mo.grid.dev", &[]), "wisp Cloud");
    assert_eq!(grid_label(Some("wisp Cloud"), Some("sam"), "sam.grid.dev", &["wisp Cloud"]), "wisp Cloud (sam)");
    assert_eq!(grid_label(None, None, "mo.grid.dev", &[]), "mo.grid.dev");
    assert_eq!(origin_port("https://mo.grid.dev"), 443);
    assert_eq!(origin_port("http://mo.localhost:8080"), 8080);
    assert_eq!(origin_port("http://127.0.0.1"), 80);
    assert_eq!(handle([0xab, 0x01, 0xff]), "ab01ff");
}

#[test]
fn an_older_wisp_there_can_be_updated_to_this_version() {
    assert_eq!(update_to("0.10.0", Some("0.9.0"), "").as_deref(), Some("0.10.0"));
    assert_eq!(update_to("0.10.0", Some("0.10.0"), ""), None);
    assert_eq!(update_to("0.10.0", Some("0.11.0"), ""), None, "newer there: leave it");
    assert_eq!(update_to("0.10.0", None, ""), None, "not connected yet");
    assert_eq!(update_to("0.10.0", Some("0.9.0"), "wisp"), None, "a custom command picks the version");
    assert!(newer("1.0.0", "1.0.0-beta.2") && !newer("1.0.0-beta.2", "1.0.0"));
    assert!(newer("1.0.0-beta.10", "1.0.0-beta.2") && newer("1.0.0-beta.2.1", "1.0.0-beta.2"));
    assert!(newer("1.0.0-beta", "1.0.0-2"), "numbers sort before words");
    assert!(newer("v2.0.0", "1.9.9") && !newer("2.0.0+build", "2.0.0"));
}

#[test]
fn harnesses_keep_signed_in_only_when_false() {
    let a = remote_agents(&json!([{"id": "claude", "name": "Claude Code", "available": true, "signedIn": true, "extra": 1}, {"id": "codex", "available": false, "signedIn": false}, {"name": "no id"}]));
    assert_eq!(a.len(), 2);
    assert_eq!(a[0].signed_in, None);
    assert_eq!(a[1].signed_in, Some(false));
    assert!(remote_agents(&json!({"not": "a list"})).is_empty());
}

#[test]
fn the_card_keeps_v1s_names() {
    let mut r = PeerRow { transport: "grid-tunnel".into(), ..row() };
    r.data.insert("computer".into(), json!("c1"));
    r.data.insert("url".into(), json!("https://studio--mo.grid.dev"));
    let mut st = PeerStatus::off("ab12cd");
    st.state = PeerState::Online;
    st.stale = Some(4);
    st.remote = Some(RemoteInfo { version: Some("1.9.0".into()), ..RemoteInfo::default() });
    let v = serde_json::to_value(view(&r, &st, Extras { version: "2.0.0".into(), default_command: "~/.wisp/bin/2.0.0/wisp".into(), log: vec!["x".into()], projects: 2, working: 1 })).unwrap_or_default();
    assert_eq!((v["kind"].clone(), v["target"].clone(), v["computer"].clone(), v["url"].clone()), (json!("grid"), json!("me@devbox"), json!("c1"), json!("https://studio--mo.grid.dev")));
    assert_eq!((v["stale"].clone(), v["outdated"].clone(), v["autoConnect"].clone(), v["defaultCommand"].clone()), (json!(true), json!("2.0.0"), json!(true), json!("~/.wisp/bin/2.0.0/wisp")));
    assert_eq!((v["state"].clone(), v["projects"].clone(), v["working"].clone()), (json!("online"), json!(2), json!(1)));
}

#[test]
fn a_loopback_peer_stays_on_this_computer() {
    let c = clean_loopback(&args(json!({"address": "LOCALHOST", "port": 4999})), None);
    assert_eq!(c, Ok(Cleaned { name: Some("localhost:4999".into()), address: Some("localhost".into()), port: Some(4999), command: Some(String::new()), auto_connect: Some(true) }));
    assert!(clean_loopback(&args(json!({"address": "10.0.0.2", "port": 4999})), None).is_err(), "off the computer: refused");
    assert_eq!(clean_loopback(&args(json!({"address": "127.0.0.1"})), None), Err("Port: a number from 1 to 65535.".into()), "no default port");
    let prev = PeerRow { transport: "loopback".into(), address: "127.0.0.1".into(), port: 5000, ..row() };
    assert_eq!(clean_loopback(&args(json!({"name": "other home"})), Some(&prev)).ok().and_then(|c| c.port), Some(5000));
}
