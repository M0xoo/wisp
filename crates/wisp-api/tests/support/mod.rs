//! A real edge on a random port over a fake backend, and a raw HTTP/1.1 client (raw, so a test sets
//! any Host or Origin it likes and sees exactly what went over the wire).
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_panics_doc,
    clippy::needless_pass_by_value,
    clippy::format_push_string
)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use wisp_api::backend::{Backend, Binding};
use wisp_api::router::{Invoke, Spec};
use wisp_api::{Edge, EdgeConfig, Hub, Server};
use wisp_kernel::http::{Liveness, OPEN, OPEN_QUIET, Response, StatusPart};
use wisp_kernel::{BoxFuture, Caller, Result, WireError};

pub const MASTER: &str = "master-token-for-tests-0123456789";
pub const SECRET: &str = "proxy-secret-0123456789abcdef-0123";

pub struct Fake {
    pub calls: AtomicUsize,
    pub live: u32,
}

fn spec(method: &str, pattern: &str, permission: &str) -> Spec {
    Spec {
        method: method.into(),
        pattern: pattern.into(),
        raw: false,
        permission: permission.into(),
        doc: true,
        summary: format!("{method} {pattern}"),
        max_body: None,
        owner: "wisp.fake".into(),
    }
}

fn bind(spec: Spec, f: impl Fn(Caller, wisp_kernel::http::Request) -> Result<Response> + Send + Sync + 'static) -> Binding {
    let f = Arc::new(f);
    let invoke: Invoke = Arc::new(move |c, r| {
        let f = f.clone();
        Box::pin(async move { f(c, r) })
    });
    Binding { spec, invoke }
}

pub static BIG: std::sync::LazyLock<Arc<Value>> =
    std::sync::LazyLock::new(|| Arc::new(json!({ "rows": (0..2000).map(|i| format!("row {i}")).collect::<Vec<_>>() })));

fn echo(c: Caller, r: wisp_kernel::http::Request) -> Result<Response> {
    Response::ok(
        json!({"set": c.set, "session": c.session, "params": r.params, "query": r.query, "body": String::from_utf8_lossy(&r.body)}),
    )
}

impl Backend for Fake {
    fn routes(&self) -> Vec<Binding> {
        let mut upload = bind(spec("POST", "/uploads", "uploads:write"), echo);
        upload.spec.max_body = Some(5_000_000);
        let mut hidden = bind(spec("GET", "/hidden", "settings:read"), echo);
        hidden.spec.doc = false;
        vec![
            bind(spec("GET", "/sessions/:id", "agent:read"), echo),
            bind(spec("POST", "/sessions/:id/reply", "agent:write"), echo),
            bind(spec("POST", "/internal/ask", "agent:write"), echo),
            bind(spec("GET", "/settings", "settings:read"), echo),
            upload,
            bind(spec("GET", "/big", "settings:read"), |_, _| Response::ok(&*BIG.clone())),
            bind(spec("GET", "/prepared", "settings:read"), |_, _| Ok(Response::Prepared { status: 200, body: BIG.clone() })),
            bind(spec("GET", "/hold", "settings:read"), |_, _| {
                Err(WireError::conflict("near the limit").with_details(json!({"hold": {"window": "5h"}})))
            }),
            bind(spec("GET", "/boom", "settings:read"), |_, _| Err(WireError::internal("boom"))),
            hidden,
            bind(Spec { raw: true, ..spec("POST", "/hooks/:id", OPEN) }, echo),
            bind(spec("POST", "/channels/inbound", OPEN_QUIET), echo),
            bind(spec("POST", "/apikeys", "apikeys:create"), echo),
        ]
    }
    fn status_parts(&self) -> Vec<Arc<dyn StatusPart>> {
        vec![Arc::new(Part(self.live))]
    }
    fn call(&self, caller: Caller, cmd: &str, args: Value) -> BoxFuture<'static, Result<Value>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let cmd = cmd.to_owned();
        Box::pin(async move {
            if cmd == "no.such" { Err(WireError::not_found("no.such")) } else { Ok(json!({"cmd": cmd, "args": args, "set": caller.set})) }
        })
    }
    fn explain(&self, caller: &Caller, permission: &str) -> std::result::Result<(), String> {
        match caller.set.as_str() {
            "user:full" | "box" | "apikey" => Ok(()),
            "agent:session" if permission.starts_with("agent:") => Ok(()),
            s => Err(format!("{s} may not {permission}")),
        }
    }
}

struct Part(u32);
impl StatusPart for Part {
    fn liveness(&self) -> Liveness {
        Liveness { live: self.0, next_wake_at: Some(123), ..Liveness::default() }
    }
}

pub fn config() -> EdgeConfig {
    EdgeConfig::new(MASTER, "2.0.0-test")
}

pub async fn start(cfg: EdgeConfig) -> (Server, Arc<Fake>) {
    let fake = Arc::new(Fake { calls: AtomicUsize::new(0), live: 2 });
    let edge = Edge::new(cfg, fake.clone(), Hub::new());
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    (wisp_api::serve(edge, l).await.unwrap(), fake)
}

#[derive(Debug)]
pub struct Resp {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn h(&self, k: &str) -> Option<&str> {
        self.headers.get(k).map(String::as_str)
    }
}

/// One request on its own connection: `headers` as written (the test picks Host and Origin).
pub async fn send(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Resp {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nconnection: close\r\ncontent-length: {}\r\n", body.len());
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("host: 127.0.0.1:{port}\r\n"));
    }
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).await.unwrap();
    let _ = s.write_all(body).await;
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw).await;
    parse(&raw)
}

pub fn parse(raw: &[u8]) -> Resp {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a response head");
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers: BTreeMap<String, String> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
    let rest = &raw[end + 4..];
    let body = if headers.get("transfer-encoding").is_some_and(|t| t.contains("chunked")) { unchunk(rest) } else { rest.to_vec() };
    Resp { status, headers, body }
}

fn unchunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = b.windows(2).position(|w| w == b"\r\n") {
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..i]).trim(), 16).unwrap_or(0);
        if n == 0 || b.len() < i + 2 + n {
            break;
        }
        out.extend_from_slice(&b[i + 2..i + 2 + n]);
        b = &b[(i + 4 + n).min(b.len())..];
    }
    out
}

pub fn json_h() -> (&'static str, &'static str) {
    ("content-type", "application/json")
}
