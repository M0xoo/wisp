//! hostd's container driver against a fake boxd: a run asks boxd for the box (with its secret in the env, never on
//! a command line), the box is up once its port answers, stopping it closes the run's connection, and removing it
//! asks boxd to delete it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{TcpListener, UnixListener};
use wisp_grid::boxhost::{BoxHost as _, BoxState};
use wisp_grid::rows::BoxUser;

#[derive(Default)]
struct Seen {
    asks: Vec<Value>,
    closed: bool,
}

/// boxd's side: a run starts an HTTP server on its port (the box), and stops it when the grid hangs up.
fn fake_boxd(sock: &std::path::Path, seen: Arc<Mutex<Seen>>) {
    let l = UnixListener::bind(sock).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((c, _)) = l.accept().await else { return };
            let seen = seen.clone();
            tokio::spawn(async move {
                let (rd, mut wr) = c.into_split();
                let mut lines = BufReader::new(rd).lines();
                let Ok(Some(first)) = lines.next_line().await else { return };
                let m: Value = serde_json::from_str(&first).unwrap();
                seen.lock().unwrap().asks.push(m.clone());
                if m["op"] == "remove" {
                    let _ = wr.write_all(b"{\"ok\":true}\n").await;
                    return;
                }
                let port = u16::try_from(m["port"].as_u64().unwrap()).unwrap();
                let http = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
                let server = tokio::spawn(async move {
                    loop {
                        let Ok((s, _)) = http.accept().await else { return };
                        tokio::spawn(async move {
                            let svc = hyper::service::service_fn(|_r| async {
                                Ok::<_, std::convert::Infallible>(http::Response::new(Full::new(Bytes::from_static(b"{\"ok\":true}"))))
                            });
                            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(s), svc).await;
                        });
                    }
                });
                let _ = wr.write_all(b"{\"log\":\"wisp up\\n\"}\n").await;
                // until the grid hangs up (or signals)
                while let Ok(Some(l)) = lines.next_line().await {
                    seen.lock().unwrap().asks.push(serde_json::from_str(&l).unwrap_or_default());
                    if l.contains("SIGTERM") {
                        break;
                    }
                }
                server.abort();
                seen.lock().unwrap().closed = true;
                let _ = wr.write_all(b"{\"exit\":0}\n").await;
            });
        }
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn hostd_runs_a_box_through_boxd() {
    let dir = std::env::temp_dir().join(format!("wisp-grid-boxd-driver-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("box.sock");
    let seen = Arc::new(Mutex::new(Seen::default()));
    fake_boxd(&sock, seen.clone());
    let clock = wisp_grid::clock::system();
    let o = wisp_grid::hostd::ProcessOptions {
        bin: "/nonexistent/wisp".into(),
        data: dir.clone(),
        idle_ms: 600_000,
        check_ms: 60_000,
        start_ms: 10_000,
        max_running: 2,
        env: vec![("EXTRA".into(), "1".into())],
        url_of: Arc::new(|h| format!("https://{h}.grid.test")),
        boxd: Some(wisp_grid::boxd::Driver { socket: sock.clone(), limits: json!({ "memory": "2g" }), dns: None }),
    };
    let host = wisp_grid::hostd::ProcessHost::new(o, clock);
    let ada = BoxUser { id: "u1".into(), handle: "ada".into(), sandbox: None, owner: None };
    let up = host.ensure(&ada, false).await.unwrap();
    assert_eq!(host.state("u1"), BoxState::Running);
    assert_eq!(host.port("u1"), Some(up.port));
    {
        let s = seen.lock().unwrap();
        let run = &s.asks[0];
        assert_eq!((run["op"].as_str(), run["id"].as_str(), run["limits"]["memory"].as_str()), (Some("run"), Some("u1"), Some("2g")));
        assert_eq!(run["env"]["WISP_BOX"], "1");
        assert_eq!(run["env"]["WISP_PUBLIC_URL"], "https://ada.grid.test");
        assert_eq!(run["env"]["EXTRA"], "1", "the operator's env goes in too");
        let secret = run["env"]["WISP_TRUSTED_PROXY_SECRET"].as_str().unwrap();
        assert_eq!(host.secret("u1").as_deref(), Some(secret), "the secret the edge sends is the box's");
    }
    assert!(host.stop("u1", "idle").await.unwrap());
    assert_eq!(host.state("u1"), BoxState::Stopped);
    assert!(seen.lock().unwrap().closed, "stopping it ended the run at boxd");
    // read once the run's exit came back: boxd's log lines reach the file from their own task, so right after
    // `ensure` the line may not be there yet (1 failure in 160 runs under load; the full PR CI suite hit it)
    let log = std::fs::read_to_string(dir.join("users/u1/wisp.log")).unwrap_or_default();
    assert!(log.contains("wisp up"), "boxd's log lines land in the box's log: {log:?}");
    host.remove(&ada).await.unwrap();
    assert!(seen.lock().unwrap().asks.iter().any(|m| m["op"] == "remove" && m["id"] == "u1"), "boxd deletes it");
}
