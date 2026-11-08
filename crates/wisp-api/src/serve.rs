//! Listening (edge cases 8 and 10): HTTP/1.1 with upgrades (previews' websockets) and h2c, keep-alive
//! idle and header reads bounded by `keep_alive` (65 s: longer than the 60 s idle of the proxies in
//! front, so they never reuse a socket wisp is closing). `server.json` is written once listening, so
//! integrations (CLI, MCP, editors) find wisp without knowing the port, and removed on exit only if its
//! pid is ours (a second wisp that failed to bind must not delete the first one's).
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::GracefulShutdown;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::edge::{API_VERSION, Edge, now_ms};

/// How long open connections get to finish once wisp stops.
const DRAIN: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub struct Server {
    pub addr: SocketAddr,
    edge: Arc<Edge>,
    task: JoinHandle<()>,
    advertised: Option<PathBuf>,
}

impl Server {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    pub fn edge(&self) -> &Arc<Edge> {
        &self.edge
    }

    /// Stops accepting, ends the streams, lets requests in flight finish (at most 2 s), removes server.json.
    pub async fn shutdown(self) {
        self.edge.shutdown();
        let _ = self.task.await;
        if let Some(f) = &self.advertised {
            remove_if_ours(f).await;
        }
    }
}

/// Serves `edge` on `listener` until `edge.shutdown()`.
pub async fn serve(edge: Arc<Edge>, listener: TcpListener) -> std::io::Result<Server> {
    let addr = listener.local_addr()?;
    edge.port.store(addr.port(), Ordering::Relaxed);
    let server_json = match &edge.cfg.home {
        Some(home) => Some(write_server_json(home, addr.port(), &edge.cfg.version).await?),
        None => None,
    };
    spawn_pings(&edge);
    if let Some(s) = edge.statics.clone() {
        tokio::spawn(async move { s.warm().await });
    }
    let task = tokio::spawn(accept_loop(edge.clone(), listener));
    Ok(Server {
        addr,
        edge,
        task,
        advertised: server_json,
    })
}

fn spawn_pings(edge: &Arc<Edge>) {
    let (hub, stop) = (edge.hub.clone(), edge.stop.clone());
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(crate::sync::PING_SECS));
        t.tick().await;
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                _ = t.tick() => hub.ping(),
            }
        }
    });
}

async fn accept_loop(edge: Arc<Edge>, listener: TcpListener) {
    let mut builder = Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .keep_alive(true)
        .header_read_timeout(edge.cfg.keep_alive);
    let graceful = GracefulShutdown::new();
    let stop = edge.stop.clone();
    loop {
        let (stream, _) = tokio::select! {
            () = stop.cancelled() => break,
            r = listener.accept() => match r {
                Ok(s) => s,
                Err(e) => {
                    // EMFILE and friends: back off a little instead of spinning
                    tracing::warn!("accept: {e}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
        };
        let _ = stream.set_nodelay(true);
        let e = edge.clone();
        let svc = service_fn(move |req| {
            let e = e.clone();
            async move { Ok::<_, std::convert::Infallible>(e.handle(req).await) }
        });
        let conn = builder
            .serve_connection_with_upgrades(TokioIo::new(stream), svc)
            .into_owned();
        let conn = graceful.watch(conn);
        tokio::spawn(async move {
            let _ = conn.await;
        });
    }
    drop(listener);
    let _ = tokio::time::timeout(DRAIN, graceful.shutdown()).await;
}

async fn write_server_json(home: &Path, port: u16, version: &str) -> std::io::Result<PathBuf> {
    tokio::fs::create_dir_all(home).await?;
    let file = home.join("server.json");
    let body = json!({"url": format!("http://127.0.0.1:{port}"), "port": port, "pid": std::process::id(), "version": version, "apiVersion": API_VERSION, "startedAt": now_ms()});
    let tmp = home.join(format!("server.json.{}.tmp", std::process::id()));
    tokio::fs::write(&tmp, serde_json::to_vec_pretty(&body).unwrap_or_default()).await?;
    tokio::fs::rename(&tmp, &file).await?;
    Ok(file)
}

/// Removes server.json only if it still names this process.
pub async fn remove_if_ours(file: &Path) {
    let Ok(text) = tokio::fs::read(file).await else {
        return;
    };
    let pid = serde_json::from_slice::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("pid").and_then(serde_json::Value::as_u64));
    if pid == Some(u64::from(std::process::id())) {
        let _ = tokio::fs::remove_file(file).await;
    }
}
