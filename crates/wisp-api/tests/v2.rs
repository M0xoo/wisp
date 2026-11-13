//! The v2 sync stream through the edge: wisp-sync's machine carried onto a real socket.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use support::{Fake, config, json_h, send};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wisp_api::v2::{Driver, Empty};
use wisp_api::{Edge, Hub};
use wisp_protocol::PeerInfo;

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

/// Reads from the stream until `want` shows up (or 3 s pass).
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
async fn hello_sub_snapshot_mutate_ack() {
    let fake = Arc::new(Fake { calls: std::sync::atomic::AtomicUsize::new(0), live: 0 });
    let hub = Hub::new();
    hub.mount(Driver::start(Arc::new(Empty { epoch: "e1".into() }), fake.clone(), peer()));
    let edge = Edge::new(config(), fake.clone(), hub);
    let server = wisp_api::serve(edge, tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()).await.unwrap();
    let p = server.addr.port();

    let mut c = tokio::net::TcpStream::connect(("127.0.0.1", p)).await.unwrap();
    let q = "proto_min=2&proto_max=2&client_id=c1&build=t";
    c.write_all(format!("GET /api/events?{q} HTTP/1.1\r\nhost: 127.0.0.1:{p}\r\n\r\n").as_bytes()).await.unwrap();
    let mut seen = String::new();
    until(&mut c, &mut seen, "welcome").await;
    assert!(seen.contains("text/event-stream"));
    assert!(seen.contains("\"epoch\":\"e1\""), "{seen}");

    let post =
        |body: &'static str| async move { send(p, "POST", "/api/events", &[json_h(), ("x-wisp-client", "c1")], body.as_bytes()).await };
    assert_eq!(post(r#"{"t":"sub","topic":"list"}"#).await.status, 200);
    until(&mut c, &mut seen, "snapshot").await;
    assert!(seen.contains("\"topic\":\"list\""), "{seen}");
    // the machine's clock wakes the actor only when it asks: a quiet stream still gets its frames
    assert_eq!(post(r#"{"t":"mutate","mid":"m1","cmd":"runtime.rename","args":{"title":"x"}}"#).await.status, 200);
    until(&mut c, &mut seen, "\"mid\":\"m1\"").await;
    assert!(seen.contains("ack"), "{seen}");
    // the same mid again runs nothing
    assert_eq!(post(r#"{"t":"mutate","mid":"m1","cmd":"runtime.rename","args":{"title":"x"}}"#).await.status, 200);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    // an active subscription counts as someone looking
    assert_eq!(send(p, "GET", "/api/status", &[], b"").await.json()["clients"], 1);
    // a stream belongs to whoever opened it; an unknown client has none
    assert_eq!(
        send(p, "POST", "/api/events", &[json_h(), ("x-wisp-client", "nobody")], br#"{"t":"sub","topic":"list"}"#).await.status,
        404
    );
    // a notice reaches v2 streams as a notice frame
    wisp_kernel::services::Notify::notice(&**server.edge().hub(), "toast", serde_json::json!({"text": "hi"}), None);
    until(&mut c, &mut seen, "\"kind\":\"toast\"").await;
    drop(c);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(send(p, "GET", "/api/status", &[], b"").await.json()["clients"], 0, "a closed stream stops counting");
    server.shutdown().await;
}
