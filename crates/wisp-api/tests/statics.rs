//! docs/v1-edge-cases.md → The HTTP edge, bullets 6, 7 and 10: the web bundle, /_pack, previews and
//! server.json, against a real socket.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::many_single_char_names,
    clippy::used_underscore_binding
)]

mod support;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use support::{SECRET, config, send, start};
use wisp_api::TrustedProxy;

fn web() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "wisp-api-web-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::create_dir_all(d.join("assets")).unwrap();
    std::fs::write(d.join("index.html"), r#"<html><head><link rel="modulepreload" href="/assets/dep-AbCdEf12.js"><script type="module" src="/assets/index-B3x9_aQz.js"></script></head><body></body></html>"#).unwrap();
    std::fs::write(
        d.join("assets/index-B3x9_aQz.js"),
        format!(
            "import './dep-AbCdEf12.js';\n{}",
            "console.log('wisp');\n".repeat(200)
        ),
    )
    .unwrap();
    std::fs::write(d.join("assets/dep-AbCdEf12.js"), "export const x = 1;\n").unwrap();
    std::fs::write(
        d.join("sw.js"),
        "self.addEventListener('fetch', () => {});\n",
    )
    .unwrap();
    std::fs::write(d.join("video.mp4"), vec![7u8; 4_200_000]).unwrap();
    d
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[tokio::test]
async fn bullet6_static_files() {
    let mut cfg = config();
    cfg.web_dir = Some(web());
    let (s, _) = start(cfg).await;
    let p = s.addr.port();
    let asset = send(p, "GET", "/assets/index-B3x9_aQz.js", &[], b"").await;
    assert_eq!(
        (asset.status, asset.h("cache-control")),
        (200, Some("public, max-age=31536000, immutable"))
    );
    assert_eq!(
        asset.h("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    let sw = send(p, "GET", "/sw.js", &[], b"").await;
    assert_eq!(sw.h("cache-control"), Some("no-cache"));
    let etag = sw.h("etag").unwrap().to_owned();
    assert_eq!(
        send(p, "GET", "/sw.js", &[("if-none-match", &etag)], b"")
            .await
            .status,
        304
    );
    // index.html names the build; any app path is the app; a missing chunk fails loudly
    let page = send(p, "GET", "/", &[], b"").await;
    let build = page.h("x-wisp-build").unwrap().to_owned();
    assert!(
        String::from_utf8_lossy(&page.body)
            .contains(&format!("<meta name=\"wisp-build\" content=\"{build}\">"))
    );
    assert_eq!(page.h("cache-control"), Some("no-cache"));
    let spa = send(p, "GET", "/s/abc", &[], b"").await;
    assert_eq!(
        (spa.status, spa.h("x-wisp-build")),
        (200, Some(build.as_str()))
    );
    assert_eq!(
        send(p, "GET", "/assets/gone-12345678.js", &[], b"")
            .await
            .status,
        404
    );
    // a plugin view's id has a dot (`stuff.page`): its deep link is the app, not a missing file
    let view = send(p, "GET", "/view/stuff.page", &[], b"").await;
    assert_eq!((view.status, view.h("x-wisp-build")), (200, Some(build.as_str())));
    // no way out of the bundle, escaped or not
    for out in [
        "/../Cargo.toml",
        "/assets/..%2F..%2FCargo.toml",
        "/%2e%2e/%2e%2e/etc/passwd",
    ] {
        let r = send(p, "GET", out, &[], b"").await;
        assert!(
            !String::from_utf8_lossy(&r.body).contains("[package]")
                && !String::from_utf8_lossy(&r.body).contains("root:"),
            "{out}"
        );
    }
    // the phone's first open: modules wait for the service worker
    let boot = send(
        p,
        "GET",
        "/",
        &[("user-agent", "Mozilla/5.0 wispMobile/2")],
        b"",
    )
    .await;
    let html = String::from_utf8_lossy(&boot.body).into_owned();
    assert!(html.contains("serviceWorker") && !html.contains("<script type=\"module\""));
    let with_sw = send(
        p,
        "GET",
        "/",
        &[
            ("user-agent", "Mozilla/5.0 wispMobile/2"),
            ("x-wisp-sw", "1"),
        ],
        b"",
    )
    .await;
    assert!(String::from_utf8_lossy(&with_sw.body).contains("<script type=\"module\""));
    // bigger than 4 MB: streamed, with ranges
    let r = send(p, "GET", "/video.mp4", &[("range", "bytes=100-199")], b"").await;
    assert_eq!(
        (r.status, r.h("content-range"), r.body.len()),
        (206, Some("bytes 100-199/4200000"), 100)
    );
    assert_eq!(
        send(p, "GET", "/video.mp4", &[("range", "bytes=5000000-")], b"")
            .await
            .status,
        416
    );
    let whole = send(p, "GET", "/video.mp4", &[], b"").await;
    assert_eq!((whole.status, whole.body.len()), (200, 4_200_000));
    // compressed copies land in the background: brotli once ready
    tokio::time::sleep(Duration::from_millis(600)).await;
    let br = send(
        p,
        "GET",
        "/assets/index-B3x9_aQz.js",
        &[("accept-encoding", "br")],
        b"",
    )
    .await;
    assert_eq!(br.h("content-encoding"), Some("br"));
    s.shutdown().await;
}

#[tokio::test]
async fn bullet7_pack_has_every_module_minus_those_the_worker_has() {
    let mut cfg = config();
    cfg.web_dir = Some(web());
    let (s, _) = start(cfg).await;
    let p = s.addr.port();
    let all = send(p, "GET", "/_pack", &[], b"").await;
    assert_eq!(
        (all.h("cache-control"), all.h("content-type")),
        (Some("no-store"), Some("application/json"))
    );
    let v = all.json();
    let urls: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(
        urls,
        [
            "/assets/dep-AbCdEf12.js",
            "/assets/index-B3x9_aQz.js",
            "/sw.js"
        ]
    );
    let some = send(
        p,
        "GET",
        "/_pack?have=/assets/dep-AbCdEf12.js,%2Fsw.js",
        &[],
        b"",
    )
    .await
    .json();
    assert_eq!(
        some.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["/assets/index-B3x9_aQz.js"]
    );
    let br = send(p, "GET", "/_pack", &[("accept-encoding", "br")], b"").await;
    assert_eq!(br.h("content-encoding"), Some("br"));
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut brotli::Decompressor::new(&br.body[..], 4096), &mut out)
        .unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&out).unwrap(), v);
    s.shutdown().await;
}

/// A dev server on a random port: answers its path, Host and a redirect to localhost.
async fn dev_server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut c, _)) = l.accept().await else {
                return;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 8192];
                let n = c.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                let leaked = req.contains("x-wisp-");
                let host = req
                    .lines()
                    .find_map(|l| l.strip_prefix("host: "))
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                let body = format!("{{\"host\":\"{host}\",\"leaked\":{leaked}}}");
                let resp = format!(
                    "HTTP/1.1 302 Found\r\nlocation: http://localhost:{port}/login\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = c.write_all(resp.as_bytes()).await;
            });
        }
    });
    port
}

#[tokio::test]
async fn bullet10_previews_and_server_json() {
    let home = std::env::temp_dir().join(format!("wisp-api-home-{}", rand_suffix()));
    let mut cfg = config();
    cfg.proxy = TrustedProxy::new(Some(SECRET), Some("https://ada.grid.example"));
    cfg.previews = true;
    cfg.home = Some(home.clone());
    let (s, _) = start(cfg).await;
    let p = s.addr.port();
    let sj: Value =
        serde_json::from_slice(&std::fs::read(home.join("server.json")).unwrap()).unwrap();
    assert_eq!(
        (
            sj["port"].clone(),
            sj["pid"].clone(),
            sj["apiVersion"].clone()
        ),
        (json!(p), json!(std::process::id()), json!(1))
    );
    let dev = dev_server().await;
    let devs = dev.to_string();
    let via = |port: &str| {
        vec![
            ("host", "p--ada.grid.example".to_owned()),
            ("x-wisp-proxy-secret", SECRET.to_owned()),
            ("x-wisp-preview", port.to_owned()),
        ]
    };
    let h = via(&devs);
    let hr: Vec<(&str, &str)> = h.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let r = send(p, "GET", "/anything?x=1", &hr, b"").await;
    assert_eq!(
        (r.status, r.h("location")),
        (302, Some("/login")),
        "a redirect to localhost stays on the preview"
    );
    assert_eq!(
        r.json(),
        json!({"host": format!("localhost:{dev}"), "leaked": false})
    );
    // never wisp's own port, and nothing listening is a page saying so
    let own = via(&p.to_string());
    let own: Vec<(&str, &str)> = own.iter().map(|(k, v)| (*k, v.as_str())).collect();
    assert_eq!(send(p, "GET", "/", &own, b"").await.status, 404);
    let dead_port = {
        tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    let dead = via(&dead_port.to_string());
    let dead: Vec<(&str, &str)> = dead.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let r = send(p, "GET", "/", &dead, b"").await;
    assert_eq!(r.status, 502);
    assert!(String::from_utf8_lossy(&r.body).contains("Nothing answers on port"));
    // without the proxy's secret, x-wisp-preview means nothing
    assert_eq!(
        send(p, "GET", "/api/health", &[("x-wisp-preview", &devs)], b"")
            .await
            .status,
        200
    );
    s.shutdown().await;
    assert!(
        !home.join("server.json").exists(),
        "removed on exit: its pid was ours"
    );
}

#[tokio::test]
async fn server_json_of_another_wisp_is_left_alone() {
    let home = std::env::temp_dir().join(format!("wisp-api-home2-{}", rand_suffix()));
    let mut cfg = config();
    cfg.home = Some(home.clone());
    let (s, _) = start(cfg).await;
    std::fs::write(home.join("server.json"), r#"{"port": 1, "pid": 1}"#).unwrap();
    s.shutdown().await;
    assert!(home.join("server.json").exists());
}

#[tokio::test]
async fn previews_off_unless_configured() {
    let mut cfg = config();
    cfg.proxy = TrustedProxy::new(Some(SECRET), None);
    let (s, _) = start(cfg).await;
    let r = send(
        s.addr.port(),
        "GET",
        "/",
        &[
            ("host", "x"),
            ("x-wisp-proxy-secret", SECRET),
            ("x-wisp-preview", "5173"),
        ],
        b"",
    )
    .await;
    assert_eq!(r.status, 404);
    s.shutdown().await;
}
