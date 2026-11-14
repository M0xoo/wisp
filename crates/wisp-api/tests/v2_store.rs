//! The v2 stream on a real store: snapshots from its tables, deltas from its change feed, and every
//! commit reaching an open stream (`Store::on_commit` → `Driver::committed`), as `wisp serve` wires it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use support::{Fake, config, json_h, send};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wisp_api::v2::{Driver, Snapshots};
use wisp_api::v2_store::{Live, StoreSnapshots, TopicReader, TopicSource, feed, live_changes, to_wire};
use wisp_api::{Edge, Hub};
use wisp_protocol::{Change, PeerInfo, Topic};
use wisp_store::{Location, ManualClock, Query, Store, row};

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

fn sources() -> Vec<TopicSource> {
    vec![TopicSource { kind: "setting", key: "key", matches: |t| t == "config", query: |_| Query::new() }]
}

fn store() -> Store {
    Store::open(Location::Memory, Arc::new(ManualClock::new(1_000))).unwrap()
}

async fn set(s: &Store, key: &'static str, value: &'static str) {
    s.write(move |w| {
        w.upsert("setting", row!({"key": key, "value": value, "locked_by": null}))?;
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn snapshot_then_delta_from_the_store() {
    let s = store();
    set(&s, "theme", "dark").await;
    let snaps = StoreSnapshots::new(s.clone(), sources(), Vec::new());
    let config = Topic::parse("config").unwrap();
    let full = snaps.snapshot(&config, None).await;
    assert!(full.full);
    assert_eq!(full.rows.len(), 1);
    assert_eq!((full.rows[0].e.as_str(), full.rows[0].id.as_str()), ("setting", "theme"));
    assert_eq!(snaps.head_seq(), full.seq, "the head follows the commits");

    set(&s, "volume", "3").await;
    set(&s, "theme", "light").await;
    let delta = snaps.snapshot(&config, Some(full.seq)).await;
    assert!(!delta.full);
    let ids: Vec<&str> = delta.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["volume", "theme"], "each row once, at its latest change");
    assert_eq!(delta.rows[1].v["value"], "light");
    assert_eq!(snaps.head_seq(), delta.seq);

    // a topic no source names reads from the change feed
    let other = snaps.snapshot(&Topic::parse("list").unwrap(), None).await;
    assert!(other.full && other.rows.is_empty());
}

/// A plugin's own first-look read (wisp.runtime's task window): it answers the full snapshot in place of the
/// change feed; a resume still reads only what changed.
#[tokio::test]
async fn a_topic_reader_answers_the_first_look_and_a_resume_reads_the_feed() {
    let s = store();
    set(&s, "theme", "dark").await;
    let snaps = StoreSnapshots::new(s.clone(), sources(), Vec::new()).with_readers(vec![TopicReader {
        matches: |t| t == "config",
        read: |_, _| Ok(vec![("setting".into(), "windowed".into(), serde_json::Map::new())]),
        kinds: &["setting"],
        live: None,
    }]);
    let config = Topic::parse("config").unwrap();
    let full = snaps.snapshot(&config, None).await;
    assert!(full.full);
    assert_eq!(full.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["windowed"], "the reader wins over the source");
    set(&s, "volume", "3").await;
    let delta = snaps.snapshot(&config, Some(full.seq)).await;
    assert!(!delta.full);
    assert_eq!(delta.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["volume"]);
}

/// Another plugin's kind on a reader's topic (wisp.goal's checks on `session:<id>`) comes in full beside the reader's
/// rows on a first look; a kind the reader answers for never comes twice.
#[tokio::test]
async fn a_first_look_brings_other_kinds_on_a_readers_topic_once() {
    let s = store();
    set(&s, "theme", "dark").await;
    let snaps = StoreSnapshots::new(s.clone(), sources(), Vec::new()).with_readers(vec![TopicReader {
        matches: |t| t == "config",
        read: |_, _| Ok(vec![("turn".into(), "t1".into(), serde_json::Map::new())]),
        kinds: &["turn"],
        live: None,
    }]);
    let full = snaps.snapshot(&Topic::parse("config").unwrap(), None).await;
    let ids: Vec<(&str, &str)> = full.rows.iter().map(|r| (r.e.as_str(), r.id.as_str())).collect();
    assert_eq!(ids, [("turn", "t1"), ("setting", "theme")]);
}

#[tokio::test]
async fn commits_become_wire_changes() {
    let s = store();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let _sub = s.on_commit(move |rows| {
        let _ = tx.send(rows.iter().flat_map(to_wire).collect::<Vec<_>>());
    });
    set(&s, "theme", "dark").await;
    set(&s, "theme", "light").await;
    let first = rx.recv().await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].topic.as_str(), "config");
    assert!(matches!(&first[0].change, Change::Upsert { v } if v["value"] == "dark"));
    let second = rx.recv().await.unwrap();
    assert!(matches!(&second[0].change, Change::Patch { ops } if !ops.is_empty()), "an update is a patch");
    assert!(second[0].seq > first[0].seq);
}

async fn until(c: &mut tokio::net::TcpStream, seen: &mut String, want: &str) {
    let mut buf = vec![0u8; 8192];
    let end = tokio::time::Instant::now() + Duration::from_secs(3);
    while !seen.contains(want) {
        let n = tokio::time::timeout_at(end, c.read(&mut buf)).await.unwrap_or_else(|_| panic!("no {want} in {seen}")).unwrap();
        assert!(n > 0, "stream closed before {want}: {seen}");
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
}

#[tokio::test]
async fn a_commit_reaches_an_open_stream() {
    let s = store();
    set(&s, "theme", "dark").await;
    let fake = Arc::new(Fake { calls: std::sync::atomic::AtomicUsize::new(0), live: 0 });
    let hub = Hub::new();
    let driver = Driver::start(Arc::new(StoreSnapshots::new(s.clone(), sources(), Vec::new())), fake.clone(), peer());
    let _feed = feed(&s, driver.clone());
    hub.mount(driver);
    let server =
        wisp_api::serve(Edge::new(config(), fake, hub), tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()).await.unwrap();
    let p = server.addr.port();
    let mut c = tokio::net::TcpStream::connect(("127.0.0.1", p)).await.unwrap();
    let q = "proto_min=2&proto_max=2&client_id=c1&build=t";
    c.write_all(format!("GET /api/events?{q} HTTP/1.1\r\nhost: 127.0.0.1:{p}\r\n\r\n").as_bytes()).await.unwrap();
    let mut seen = String::new();
    until(&mut c, &mut seen, "welcome").await;
    assert!(seen.contains(&format!("\"epoch\":\"{}\"", s.epoch())), "the store's epoch: {seen}");
    let sub = send(p, "POST", "/api/events", &[json_h(), ("x-wisp-client", "c1")], br#"{"t":"sub","topic":"config"}"#).await;
    assert_eq!(sub.status, 200);
    until(&mut c, &mut seen, "\"theme\"").await;
    set(&s, "volume", "3").await;
    until(&mut c, &mut seen, "\"volume\"").await;
    server.shutdown().await;
}

/// A reader's [`Live`] (the task window's: a change to a stubbed turn goes as the stub): a committed change of
/// one of its kinds goes as the upserts it gives, in their order, on their topics; a resume's rows go through
/// `delta`; another kind goes as committed.
fn stubbing() -> TopicReader {
    TopicReader {
        matches: |t| t == "config",
        read: |_, _| Ok(Vec::new()),
        kinds: &["setting"],
        live: Some(Live {
            kinds: &["setting"],
            change: |r, topic, _, id| {
                let Some(mut v) = r.get("setting", id)? else { return Ok(None) };
                v.insert("value".into(), "stubbed".into());
                Ok(Some(vec![(topic.to_owned(), id.to_owned(), v.clone()), ("list".into(), id.to_owned(), v)]))
            },
            delta: |_, _, rows| {
                for (_, v) in rows {
                    v.insert("value".into(), "stubbed".into());
                }
                Ok(())
            },
        }),
    }
}

#[tokio::test]
async fn a_live_reader_sends_a_change_as_its_rows_and_a_resume_through_its_delta() {
    let s = store();
    set(&s, "theme", "dark").await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let _tap = s.on_commit(move |rows| {
        let _ = tx.send(rows.iter().flat_map(to_wire).collect::<Vec<_>>());
    });
    let snaps = StoreSnapshots::new(s.clone(), sources(), Vec::new()).with_readers(vec![stubbing()]);
    let head = snaps.head_seq();
    set(&s, "theme", "light").await;
    let committed = rx.recv().await.unwrap();
    assert!(matches!(&committed[0].change, Change::Patch { .. }), "the store committed a diff");
    let seq = committed[0].seq;
    let sent = live_changes(&s, &[stubbing()], committed);
    let got: Vec<(&str, &str)> = sent.iter().map(|c| (c.topic.as_str(), c.id.as_str())).collect();
    assert_eq!(got, [("config", "theme"), ("list", "theme")], "its rows, in their order, on their topics");
    assert!(sent.iter().all(|c| c.seq == seq && matches!(&c.change, Change::Upsert { v } if v["value"] == "stubbed")));
    let untouched = vec![wisp_sync::ChangeRow {
        seq,
        topic: Topic::parse("config").unwrap(),
        entity: "other".into(),
        id: "x".into(),
        change: Change::Del,
        at: 0,
    }];
    assert_eq!(live_changes(&s, &[stubbing()], untouched.clone()), untouched, "another kind, or a del, goes as committed");
    let resumed = snaps.snapshot(&Topic::parse("config").unwrap(), Some(head)).await;
    assert!(!resumed.full);
    assert_eq!(resumed.rows[0].v["value"], "stubbed", "a resume goes through delta");
}
