//! Goldens: one of every message as it goes on the wire (AGENTS.md: what a peer or a released client
//! reads has goldens). Changing `goldens/messages.json` is a deliberate act; `UPDATE_GOLDENS=1`
//! rewrites it.
#![allow(clippy::unwrap_used)]

use serde_json::{Value, json};
use wisp_protocol::{
    Ack, Change, ClientMessage, CommandError, CommandResponse, EntityOp, Hello, Mutate, Notice, Patch, PatchOp, PeerInfo, Reject, Resync,
    Row, Rows, ServerMessage, Snapshot, Sub, Topic, Unsub, Welcome, Window, tag,
};

fn topic(s: &str) -> Topic {
    Topic::parse(s).unwrap()
}

fn peer() -> PeerInfo {
    PeerInfo {
        peer: "laptop".into(),
        name: "laptop".into(),
        build: "test".into(),
        version: "2.0.0".into(),
        proto_min: 2,
        proto_max: 2,
        plugins: vec![],
    }
}

fn client() -> Vec<ClientMessage> {
    vec![
        ClientMessage::Hello(Hello {
            t: tag::Hello,
            proto_min: 2,
            proto_max: 2,
            client_id: "tab".into(),
            build: "b".into(),
            epoch: Some("E1".into()),
            cursor: Some(42),
        }),
        ClientMessage::Sub(Sub { t: tag::Sub, topic: topic("session:a"), since: Some(42), passive: Some(true) }),
        ClientMessage::Sub(Sub { t: tag::Sub, topic: topic("list"), since: None, passive: None }),
        ClientMessage::Unsub(Unsub { t: tag::Unsub, topic: topic("machines") }),
        ClientMessage::Window(Window { t: tag::Window, req: "w1".into(), topic: topic("session:a"), before_seq: 900, limit: 50 }),
        ClientMessage::Mutate(Mutate {
            t: tag::Mutate,
            mid: "m1".into(),
            cmd: "session.followUp".into(),
            args: json!({"text": "hi"}),
            base_seq: Some(3),
        }),
    ]
}

fn op(change: Change) -> EntityOp {
    EntityOp { topic: topic("list"), e: "session".into(), id: "s1".into(), change }
}

fn server() -> Vec<ServerMessage> {
    vec![
        ServerMessage::Welcome(Welcome {
            t: tag::Welcome,
            epoch: "E1".into(),
            head_seq: 50,
            oldest_seq: 0,
            resume: true,
            proto: 2,
            peer: peer(),
        }),
        ServerMessage::Snapshot(Snapshot {
            t: tag::Snapshot,
            topic: topic("list"),
            seq: 50,
            rows: vec![Row { e: "session".into(), id: "s1".into(), v: json!({"title": "one"}) }],
            more: Some(true),
        }),
        ServerMessage::Patch(Patch {
            t: tag::Patch,
            seq: 51,
            ops: vec![
                op(Change::Upsert { v: json!({"title": "one"}) }),
                op(Change::Patch { ops: vec![PatchOp::Replace { path: "/title".into(), value: json!("two") }] }),
                op(Change::Append { v: vec![json!(1), json!(2)] }),
                op(Change::Del),
            ],
        }),
        ServerMessage::Rows(Rows { t: tag::Rows, req: "w1".into(), rows: vec![], done: true }),
        ServerMessage::Ack(Ack { t: tag::Ack, mid: "m1".into(), seq: 51, result: Some(json!({"id": "s2"})) }),
        ServerMessage::Reject(Reject { t: tag::Reject, mid: "m2".into(), code: "vetoed".into(), message: "over budget".into() }),
        ServerMessage::Resync(Resync { t: tag::Resync, topic: topic("session:a") }),
        ServerMessage::Notice(Notice { t: tag::Notice, kind: "denied".into(), data: json!({"topic": "session:x", "code": "forbidden"}) }),
    ]
}

fn commands() -> Vec<CommandResponse> {
    vec![
        CommandResponse::ok(7, None),
        CommandResponse::ok(8, Some(json!(1))),
        CommandResponse::err(CommandError { code: "invalid".into(), message: "bad".into(), retry: Some(false) }),
    ]
}

#[test]
fn messages_match_the_goldens_and_read_back() {
    let now = json!({
        "client": client().iter().map(|m| serde_json::to_value(m).unwrap()).collect::<Vec<_>>(),
        "server": server().iter().map(|m| serde_json::to_value(m).unwrap()).collect::<Vec<_>>(),
        "command": commands().iter().map(|m| serde_json::to_value(m).unwrap()).collect::<Vec<_>>(),
    });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/goldens/messages.json");
    if std::env::var_os("UPDATE_GOLDENS").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&now).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(now, want, "wire shapes changed: if on purpose, UPDATE_GOLDENS=1 and say so in the PR");
    // every golden reads back as the same message
    for (v, m) in want["client"].as_array().unwrap().iter().zip(client()) {
        assert_eq!(serde_json::from_value::<ClientMessage>(v.clone()).unwrap(), m);
    }
    for (v, m) in want["server"].as_array().unwrap().iter().zip(server()) {
        assert_eq!(serde_json::from_value::<ServerMessage>(v.clone()).unwrap(), m);
    }
    for (v, m) in want["command"].as_array().unwrap().iter().zip(commands()) {
        assert_eq!(serde_json::from_value::<CommandResponse>(v.clone()).unwrap(), m);
    }
}

#[test]
fn a_tag_decodes_only_its_own_message() {
    assert!(serde_json::from_value::<Resync>(json!({"t": "unsub", "topic": "list"})).is_err());
    assert!(serde_json::from_value::<ServerMessage>(json!({"t": "boom"})).is_err());
    assert!(serde_json::from_value::<ServerMessage>(json!({"topic": "list"})).is_err());
    assert!(serde_json::from_value::<ClientMessage>(json!({"t": "sub", "topic": "nope"})).is_err());
    assert!(serde_json::from_value::<CommandResponse>(json!({"ok": "yes"})).is_err());
    assert!(serde_json::from_value::<CommandResponse>(json!({"ok": false, "seq": 1})).is_err());
}
