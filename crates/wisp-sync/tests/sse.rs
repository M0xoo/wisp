//! SSE framing and the parser: one id, one event, one line of JSON; LF, CRLF and CR streams decode
//! the same whole, byte by byte, or split at random (UTF-8 cut mid-sequence). The TS twin's sse.test.ts.
// tests may panic, and their helpers trade pedantry for reading like the TS twins
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::missing_panics_doc,
    clippy::assert_is_empty,
    clippy::doc_markdown,
    clippy::type_complexity,
    clippy::range_plus_one,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::collapsible_if,
    clippy::semicolon_if_nothing_returned
)]

mod support;

use serde_json::json;
use support::{Rng, topic};
use wisp_protocol::{
    Ack, Change, EntityOp, Notice, Patch, PatchOp, Resync, Row, Rows, ServerMessage, tag,
};
use wisp_sync::sse::{HEARTBEAT, SseEvent, SseParser, decode_frame, encode_frame, retry_field};

fn frames() -> Vec<Vec<ServerMessage>> {
    let op = EntityOp {
        topic: topic("list"),
        e: "session".into(),
        id: "s1".into(),
        change: Change::Patch {
            ops: vec![PatchOp::Replace {
                path: "/title".into(),
                value: json!("a\nb\r\nc\rd"),
            }],
        },
    };
    vec![
        vec![ServerMessage::Patch(Patch {
            t: tag::Patch,
            seq: 7,
            ops: vec![op],
        })],
        vec![ServerMessage::Notice(Notice {
            t: tag::Notice,
            kind: "toast".into(),
            data: json!({"text": "héllo 👋\u{2028} done", "nul": "\u{0}"}),
        })],
        vec![
            ServerMessage::Resync(Resync {
                t: tag::Resync,
                topic: topic("session:x"),
            }),
            ServerMessage::Ack(Ack {
                t: tag::Ack,
                mid: "m1".into(),
                seq: 9,
                result: None,
            }),
        ],
        vec![ServerMessage::Rows(Rows {
            t: tag::Rows,
            req: "r".into(),
            rows: vec![Row {
                e: "event".into(),
                id: "1".into(),
                v: json!("x".repeat(5000)),
            }],
            done: true,
        })],
    ]
}

fn encode(id: u64, msgs: &[ServerMessage]) -> String {
    let parts: Vec<String> = msgs
        .iter()
        .map(|m| serde_json::to_string(m).unwrap())
        .collect();
    encode_frame(Some(id), &parts)
}

type Frame = (Option<u64>, Vec<ServerMessage>);

fn stream(end: &str) -> (String, Vec<Frame>) {
    let mut text = format!("\u{feff}{}{HEARTBEAT}", retry_field(1500));
    let mut want = vec![];
    for (i, m) in frames().into_iter().enumerate() {
        text += &encode(10 + i as u64, &m);
        text += HEARTBEAT;
        want.push((Some(10 + i as u64), m));
    }
    (text.replace('\n', end), want)
}

fn parse_all(chunks: &[&[u8]]) -> (Vec<Frame>, SseParser) {
    let mut p = SseParser::new();
    let evs: Vec<SseEvent> = chunks.iter().flat_map(|c| p.push(c)).collect();
    (evs.iter().filter_map(decode_frame).collect(), p)
}

#[test]
fn a_frame_is_one_id_one_event_one_line_of_json() {
    let f = encode(42, &frames()[0]);
    let lines: Vec<&str> = f.split('\n').collect();
    assert_eq!(&lines[..2], &["id: 42", "event: sync"]);
    assert!(lines[2].starts_with("data: ["));
    assert_eq!(&lines[3..], &["", ""]);
    assert_eq!(HEARTBEAT, ": hb\n\n");
    assert_eq!(retry_field(2000), "retry: 2000\n\n");
}

#[test]
fn parses_lf_crlf_and_cr_streams_whole_or_one_byte_at_a_time() {
    for end in ["\n", "\r\n", "\r"] {
        let (text, want) = stream(end);
        let (got, p) = parse_all(&[text.as_bytes()]);
        assert_eq!(got, want, "{end:?}");
        assert_eq!(p.retry(), Some(1500));
        assert_eq!(p.last_event_id(), Some("13"));
        let bytes: Vec<&[u8]> = text.as_bytes().chunks(1).collect();
        assert_eq!(parse_all(&bytes).0, want, "byte by byte {end:?}");
    }
}

#[test]
fn fuzz_random_splits_cut_utf8_mid_sequence_and_decode_the_same() {
    let mut r = Rng::new(99);
    for end in ["\n", "\r\n", "\r"] {
        let (text, want) = stream(end);
        let bytes = text.as_bytes();
        for _ in 0..300 {
            let mut chunks = vec![];
            let mut i = 0;
            while i < bytes.len() {
                let max = if r.next() < 0.5 { 4 } else { 400 };
                let n = 1 + r.below(max);
                chunks.push(&bytes[i..(i + n).min(bytes.len())]);
                i += n;
            }
            assert_eq!(parse_all(&chunks).0, want);
        }
    }
}

#[test]
fn the_spec_corners() {
    let mut p = SseParser::new();
    let out = p.push(b"data:a\ndata: b\nfoo: bar\nid: 5\n\nid: x\0y\nevent: e\ndata: c\n\ndata\n\n: only a comment\n\n");
    let ev = |event: &str, data: &str| SseEvent {
        id: Some("5".into()),
        event: event.into(),
        data: data.into(),
    };
    assert_eq!(
        out,
        vec![ev("message", "a\nb"), ev("e", "c"), ev("message", "")]
    );
    assert_eq!(
        decode_frame(&SseEvent {
            id: Some("1".into()),
            event: "sync".into(),
            data: "{not json".into()
        }),
        None
    );
    assert_eq!(
        decode_frame(&SseEvent {
            id: Some("1".into()),
            event: "other".into(),
            data: "[]".into()
        }),
        None
    );
    let (id, msgs) = decode_frame(&SseEvent {
        id: Some(String::new()),
        event: "sync".into(),
        data: r#"[{"t":"resync","topic":"list"},3,{"t":"future"}]"#.into(),
    })
    .unwrap();
    assert_eq!(
        (id, msgs),
        (
            None,
            vec![ServerMessage::Resync(Resync {
                t: tag::Resync,
                topic: topic("list")
            })]
        ),
        "unknown kinds are skipped"
    );
    // an event without its blank line yet is held, not dispatched
    let mut p = SseParser::new();
    assert!(p.push(b"id: 1\nevent: sync\ndata: []\n").is_empty());
    assert_eq!(p.push(b"\n").len(), 1);
}
