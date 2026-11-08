//! docs/v1-edge-cases.md → The HTTP edge, bullets 1–5, 8–9: each one a test against a real socket.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::many_single_char_names,
    clippy::used_underscore_binding
)]

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;
use support::{MASTER, SECRET, config, json_h, send, start};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wisp_api::TrustedProxy;
use wisp_api::auth::{connector_token, session_token};

#[tokio::test]
async fn bullet1_host_allow_list_origin_and_open_routes() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    assert_eq!(send(p, "GET", "/api/settings", &[], b"").await.status, 200);
    for host in [format!("localhost:{p}"), format!("[::1]:{p}")] {
        assert_eq!(
            send(p, "GET", "/api/settings", &[("host", &host)], b"")
                .await
                .status,
            200,
            "{host}"
        );
    }
    let r = send(p, "GET", "/api/settings", &[("host", "evil.example")], b"").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (403, json!("forbidden host"))
    );
    let r = send(
        p,
        "POST",
        "/api/sessions/s1/reply",
        &[json_h(), ("origin", "https://evil.example")],
        b"{}",
    )
    .await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (403, json!("forbidden origin"))
    );
    let local = format!("http://localhost:{p}");
    assert_eq!(
        send(
            p,
            "POST",
            "/api/sessions/s1/reply",
            &[json_h(), ("origin", &local)],
            b"{}"
        )
        .await
        .status,
        200
    );
    // a trigger's secret URL authenticates itself: any Host, any Origin, any body
    let r = send(
        p,
        "POST",
        "/hooks/h1",
        &[
            ("host", "hooks.example"),
            ("origin", "https://slack.com"),
            ("content-type", "text/plain"),
        ],
        b"x",
    )
    .await;
    assert_eq!((r.status, r.json()["set"].clone()), (200, json!("public")));
    s.shutdown().await;
}

#[tokio::test]
async fn bullet1_trusted_proxy() {
    let mut cfg = config();
    cfg.proxy = TrustedProxy::new(Some(SECRET), Some("https://ada.grid.example"));
    let (s, _) = start(cfg).await;
    let p = s.addr.port();
    let via = [
        ("host", "ada.grid.example"),
        ("x-wisp-proxy-secret", SECRET),
    ];
    assert_eq!(send(p, "GET", "/api/settings", &via, b"").await.status, 200);
    let bad = [
        ("host", "ada.grid.example"),
        ("x-wisp-proxy-secret", "proxy-secret-0123456789abcdef-0124"),
    ];
    assert_eq!(send(p, "GET", "/api/settings", &bad, b"").await.status, 403);
    let post = |o: &'static str| {
        [
            ("host", "ada.grid.example"),
            ("x-wisp-proxy-secret", SECRET),
            ("origin", o),
            ("content-type", "application/json"),
        ]
    };
    assert_eq!(
        send(
            p,
            "POST",
            "/api/sessions/s1/reply",
            &post("https://ada.grid.example"),
            b"{}"
        )
        .await
        .status,
        200
    );
    assert_eq!(
        send(
            p,
            "POST",
            "/api/sessions/s1/reply",
            &post("https://evil.example"),
            b"{}"
        )
        .await
        .status,
        403
    );
    // a grid API key, checked at the grid, speaks as `apikey` and never manages API keys
    let key = [
        ("host", "ada.grid.example"),
        ("x-wisp-proxy-secret", SECRET),
        ("x-wisp-proxy-via", "key"),
        ("content-type", "application/json"),
    ];
    assert_eq!(
        send(p, "GET", "/api/settings", &key, b"").await.json()["set"],
        "apikey"
    );
    assert_eq!(
        send(p, "POST", "/api/apikeys", &key, b"{}").await.status,
        403
    );
    s.shutdown().await;
}

#[tokio::test]
async fn bullet2_json_only_and_the_2mb_cap() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    let r = send(
        p,
        "POST",
        "/api/sessions/s1/reply",
        &[("content-type", "text/plain")],
        b"hi",
    )
    .await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (415, json!("json only"))
    );
    assert_eq!(
        send(
            p,
            "POST",
            "/api/uploads",
            &[("content-type", "application/octet-stream")],
            b"\x00\xff"
        )
        .await
        .status,
        200
    );
    assert_eq!(
        send(
            p,
            "POST",
            "/api/sessions/s1/reply",
            &[("content-type", "application/octet-stream")],
            b"x"
        )
        .await
        .status,
        415
    );
    let r = send(p, "POST", "/api/sessions/s1/reply", &[json_h()], b"{nope").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (400, json!("invalid json"))
    );
    // empty is {} (v1 readJson); a long UTF-8 body decodes once, whole
    assert_eq!(
        send(p, "POST", "/api/sessions/s1/reply", &[json_h()], b"")
            .await
            .json()["body"],
        "{}"
    );
    let text = format!("{{\"t\":\"{}\"}}", "✓".repeat(50_000));
    assert_eq!(
        send(
            p,
            "POST",
            "/api/sessions/s1/reply",
            &[json_h()],
            text.as_bytes()
        )
        .await
        .json()["body"],
        text
    );
    let big = vec![b' '; 3_000_000];
    let r = send(p, "POST", "/api/sessions/s1/reply", &[json_h()], &big).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (413, json!("too_large"))
    );
    // an upload route has its own cap
    assert_eq!(
        send(
            p,
            "POST",
            "/api/uploads",
            &[("content-type", "application/octet-stream")],
            &big
        )
        .await
        .status,
        200
    );
    s.shutdown().await;
}

#[tokio::test]
async fn bullet3_tokens_speak_for_one_session() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    let t = session_token(MASTER, "s1");
    let r = send(p, "GET", "/api/sessions/s1", &[("x-wisp-token", &t)], b"").await;
    assert_eq!(
        (
            r.status,
            r.json()["set"].clone(),
            r.json()["session"].clone()
        ),
        (200, json!("agent:session"), json!("s1"))
    );
    assert_eq!(
        send(p, "GET", "/api/sessions/s2", &[("x-wisp-token", &t)], b"")
            .await
            .status,
        403
    );
    // bySession: the body names it
    assert_eq!(
        send(
            p,
            "POST",
            "/api/internal/ask",
            &[("x-wisp-token", &t), json_h()],
            br#"{"session":"s1","question":"?"}"#
        )
        .await
        .status,
        200
    );
    assert_eq!(
        send(
            p,
            "POST",
            "/api/internal/ask",
            &[("x-wisp-token", &t), json_h()],
            br#"{"session":"s2"}"#
        )
        .await
        .status,
        403
    );
    // an agent's token never reaches the user's routes
    assert_eq!(
        send(
            p,
            "GET",
            "/api/settings",
            &[("x-wisp-token", &t), ("x-wisp-session", "s1")],
            b""
        )
        .await
        .status,
        403
    );
    let r = send(p, "GET", "/api/settings", &[("x-wisp-token", "wrong")], b"").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (403, json!("bad token"))
    );
    assert_eq!(
        send(p, "GET", "/api/settings", &[("x-wisp-token", MASTER)], b"")
            .await
            .json()["set"],
        "user:full"
    );
    assert_eq!(
        send(
            p,
            "GET",
            "/api/settings",
            &[("x-wisp-token", &connector_token(MASTER))],
            b""
        )
        .await
        .status,
        403
    );
    s.shutdown().await;
}

#[tokio::test]
async fn bullet4_refusals_keep_v1_extras() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    let r = send(p, "GET", "/api/hold", &[], b"").await;
    let j = r.json();
    assert_eq!(
        (
            r.status,
            j["error"].clone(),
            j["code"].clone(),
            j["hold"]["window"].clone()
        ),
        (409, json!("near the limit"), json!("conflict"), json!("5h"))
    );
    let r = send(p, "GET", "/api/boom", &[], b"").await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (500, json!("internal"))
    );
    assert_eq!(send(p, "GET", "/api/nope", &[], b"").await.status, 404);
    s.shutdown().await;
}

#[tokio::test]
async fn bullet5_big_json_etag_304_and_compression() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    let small = send(p, "GET", "/api/settings", &[("accept-encoding", "br")], b"").await;
    assert!(small.h("etag").is_none() && small.h("content-encoding").is_none());
    let plain = send(p, "GET", "/api/big", &[], b"").await;
    let etag = plain.h("etag").unwrap().to_owned();
    assert!(etag.starts_with("W/\""));
    assert_eq!(plain.h("cache-control"), Some("private, no-cache"));
    assert_eq!(plain.json(), *support::BIG.clone());
    assert_eq!(
        send(p, "GET", "/api/big", &[("if-none-match", &etag)], b"")
            .await
            .status,
        304
    );
    let br = send(
        p,
        "GET",
        "/api/big",
        &[("accept-encoding", "gzip, deflate, br")],
        b"",
    )
    .await;
    assert_eq!(
        (br.h("content-encoding"), br.h("vary")),
        (Some("br"), Some("accept-encoding"))
    );
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut brotli::Decompressor::new(&br.body[..], 4096), &mut out)
        .unwrap();
    assert_eq!(out, plain.body);
    assert!(br.body.len() * 5 < plain.body.len());
    let gz = send(p, "GET", "/api/big", &[("accept-encoding", "gzip")], b"").await;
    assert_eq!(gz.h("content-encoding"), Some("gzip"));
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&gz.body[..]), &mut out).unwrap();
    assert_eq!(out, plain.body);
    // a prepared answer: the same ETag each time, and its compressed copy kept
    let a = send(p, "GET", "/api/prepared", &[("accept-encoding", "br")], b"").await;
    let b = send(p, "GET", "/api/prepared", &[("accept-encoding", "br")], b"").await;
    assert_eq!((a.h("etag"), a.body.len()), (b.h("etag"), b.body.len()));
    assert_eq!(
        send(
            p,
            "GET",
            "/api/prepared",
            &[("if-none-match", a.h("etag").unwrap())],
            b""
        )
        .await
        .status,
        304
    );
    s.shutdown().await;
}

#[tokio::test]
async fn bullet8_idle_keep_alive_is_closed_after_its_timeout() {
    let mut cfg = config();
    cfg.keep_alive = Duration::from_millis(300);
    let (s, _) = start(cfg).await;
    let mut c = tokio::net::TcpStream::connect(s.addr).await.unwrap();
    let req = format!(
        "GET /api/health HTTP/1.1\r\nhost: 127.0.0.1:{}\r\n\r\n",
        s.addr.port()
    );
    let mut buf = vec![0u8; 4096];
    c.write_all(req.as_bytes()).await.unwrap();
    let n = c.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
    // kept alive for a second request…
    c.write_all(req.as_bytes()).await.unwrap();
    assert!(c.read(&mut buf).await.unwrap() > 0);
    // …and closed once idle past the timeout
    let started = std::time::Instant::now();
    let n = tokio::time::timeout(Duration::from_secs(5), c.read(&mut buf))
        .await
        .expect("closed by the server")
        .unwrap_or(0);
    assert_eq!(n, 0);
    assert!(started.elapsed() >= Duration::from_millis(250));
    s.shutdown().await;
}

async fn watch(p: u16, relay: bool) -> tokio::net::TcpStream {
    let mut c = tokio::net::TcpStream::connect(("127.0.0.1", p))
        .await
        .unwrap();
    let extra = if relay { "x-wisp-relay: 1\r\n" } else { "" };
    c.write_all(
        format!("GET /api/events HTTP/1.1\r\nhost: 127.0.0.1:{p}\r\n{extra}\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = vec![0u8; 1024];
    let n = c.read(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(
        text.contains("text/event-stream") && text.contains("event: hello"),
        "{text}"
    );
    c
}

#[tokio::test]
async fn bullet9_status_for_the_grid() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    let v = send(p, "GET", "/api/status", &[], b"").await.json();
    assert_eq!(
        (
            v["live"].clone(),
            v["nextWakeAt"].clone(),
            v["clients"].clone(),
            v["version"].clone()
        ),
        (json!(2), json!(123), json!(0), json!("2.0.0-test"))
    );
    let t0 = v["lastActivityAt"].as_i64().unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    send(p, "POST", "/api/channels/inbound", &[json_h()], b"{}").await;
    assert_eq!(
        send(p, "GET", "/api/status", &[], b"").await.json()["lastActivityAt"]
            .as_i64()
            .unwrap(),
        t0,
        "a channel's message never keeps a box awake"
    );
    send(p, "GET", "/api/settings", &[], b"").await;
    assert_eq!(
        send(p, "GET", "/api/status", &[], b"").await.json()["lastActivityAt"]
            .as_i64()
            .unwrap(),
        t0,
        "reads don't count"
    );
    send(p, "POST", "/api/sessions/s1/reply", &[json_h()], b"{}").await;
    assert!(
        send(p, "GET", "/api/status", &[], b"").await.json()["lastActivityAt"]
            .as_i64()
            .unwrap()
            > t0
    );
    // an open v1 event stream counts as someone looking; a relay doesn't
    let (_a, _r) = (watch(p, false).await, watch(p, true).await);
    assert_eq!(
        send(p, "GET", "/api/status", &[], b"").await.json()["clients"],
        1
    );
    // a notice reaches v1 streams as an event of its name
    let mut a = _a;
    wisp_kernel::services::Notify::notice(&**s.edge().hub(), "toast", json!({"text": "hi"}), None);
    let mut buf = vec![0u8; 1024];
    let n = a.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).contains("event: toast\ndata: {\"text\":\"hi\"}"));
    s.shutdown().await;
}

#[tokio::test]
async fn cmd_runs_once_per_idempotency_key() {
    let (s, fake) = start(config()).await;
    let p = s.addr.port();
    let body = br#"{"cmd":"runtime.create","args":{"prompt":"x"}}"#;
    let a = send(
        p,
        "POST",
        "/api/cmd",
        &[json_h(), ("idempotency-key", "k1")],
        body,
    )
    .await;
    let b = send(
        p,
        "POST",
        "/api/cmd",
        &[json_h(), ("idempotency-key", "k1")],
        body,
    )
    .await;
    assert_eq!(
        (
            a.status,
            a.json()["ok"].clone(),
            a.json()["result"]["cmd"].clone()
        ),
        (200, json!(true), json!("runtime.create"))
    );
    assert_eq!(a.body, b.body);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        send(p, "POST", "/api/cmd", &[json_h()], body).await.status,
        400
    );
    let r = send(
        p,
        "POST",
        "/api/cmd",
        &[json_h(), ("idempotency-key", "k2")],
        br#"{"cmd":"no.such","args":{}}"#,
    )
    .await;
    assert_eq!(
        (
            r.status,
            r.json()["ok"].clone(),
            r.json()["error"]["code"].clone()
        ),
        (404, json!(false), json!("not_found"))
    );
    // the v2 stream isn't mounted in this edge: a retryable 503, while v1 streams work
    let r = send(p, "GET", "/api/events?topics=list&client_id=c1", &[], b"").await;
    assert_eq!((r.status, r.json()["retry"].clone()), (503, json!(true)));
    s.shutdown().await;
}

#[tokio::test]
async fn health_and_every_route_documented() {
    let (s, _) = start(config()).await;
    let p = s.addr.port();
    let h = send(p, "GET", "/api/health", &[], b"").await.json();
    assert_eq!(
        (h["ok"].clone(), h["name"].clone(), h["apiVersion"].clone()),
        (json!(true), json!("wisp"), json!(1))
    );
    assert_eq!(h["url"], format!("http://127.0.0.1:{p}"));
    let doc = send(p, "GET", "/api/openapi.json", &[], b"").await.json();
    let paths = doc["paths"].as_object().unwrap();
    for e in s.edge().routes() {
        let templ = e
            .path
            .split('/')
            .map(|x| {
                x.strip_prefix(':')
                    .map_or_else(|| x.to_owned(), |n| format!("{{{n}}}"))
            })
            .collect::<Vec<_>>()
            .join("/");
        let op = paths
            .get(&templ)
            .and_then(|p| p.get(e.method.to_ascii_lowercase()))
            .cloned();
        if e.doc {
            let op = op.unwrap_or_else(|| panic!("{} {} is not in openapi.json", e.method, e.path));
            assert!(
                !op["summary"].as_str().unwrap_or("").is_empty(),
                "{} {} has no summary",
                e.method,
                e.path
            );
        } else {
            assert!(op.is_none(), "{} {} is doc: false", e.method, e.path);
        }
    }
    assert!(paths.contains_key("/api/sessions/{id}") && !paths.contains_key("/api/hidden"));
    s.shutdown().await;
}
