//! The CLI's way to the running wisp (v1 server/client.js): `server.json` names its port, `GET
//! /api/health` says it is up, and a scripted command with none running starts a headless one
//! (`wisp --no-open --port N`, detached) and waits for it.
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("{0}")]
    Said(String),
    /// an HTTP refusal or error from wisp, with its status
    #[error("{message}")]
    Http { status: u16, message: String, body: Value },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl CliError {
    pub fn said(m: impl Into<String>) -> Self {
        Self::Said(m.into())
    }
    pub fn status(&self) -> u16 {
        if let Self::Http { status, .. } = self { *status } else { 0 }
    }
}

pub type Result<T> = std::result::Result<T, CliError>;

#[derive(Debug, Clone)]
pub struct Client {
    pub url: String,
    http: reqwest::Client,
    token: Option<String>,
}

/// The port `server.json` advertises, if any.
pub fn discover(home: &Path) -> Option<u16> {
    let text = std::fs::read(home.join("server.json")).ok()?;
    let v: Value = serde_json::from_slice(&text).ok()?;
    v.get("port")?.as_u64().and_then(|p| u16::try_from(p).ok())
}

impl Client {
    pub fn new(port: u16) -> Self {
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(3)).build().unwrap_or_default();
        Self { url: format!("http://127.0.0.1:{port}"), http, token: std::env::var("WISP_TOKEN").ok().filter(|t| !t.is_empty()) }
    }

    pub async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| CliError::said(e.to_string()))?;
        let read = m == reqwest::Method::GET || m == reqwest::Method::HEAD;
        // wisp takes only JSON on anything but a read, a body-less DELETE included
        let body = if read { body } else { Some(body.unwrap_or_else(|| serde_json::json!({}))) };
        let mut b = self.http.request(m, format!("{}/api{path}", self.url));
        if let Some(t) = &self.token {
            b = b.header("x-wisp-token", t);
        }
        if let Some(body) = body {
            b = b.json(&body);
        }
        let r = b.send().await.map_err(|e| CliError::said(format!("wisp at {}: {e}", self.url)))?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        let json: Value = if text.is_empty() { serde_json::json!({}) } else { serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "text": text })) };
        if status >= 400 {
            let message = json.get("error").and_then(|e| e.as_str().map(str::to_owned).or_else(|| e.get("message").and_then(Value::as_str).map(str::to_owned))).unwrap_or_else(|| format!("HTTP {status}"));
            let message = if status == 404 && message == "not found" { format!("{method} /api{path}: not in this build") } else { message };
            return Err(CliError::Http { status, message, body: json });
        }
        Ok(json)
    }

    /// Runs a command through `POST /api/cmd` (once per key), its result or the wire error's message.
    pub async fn cmd(&self, cmd: &str, args: Value) -> Result<Value> {
        let key = format!("cli-{}", crate::services::hex(&rand::random::<[u8; 12]>()));
        let mut b = self.http.post(format!("{}/api/cmd", self.url)).header("idempotency-key", key).json(&serde_json::json!({ "cmd": cmd, "args": args }));
        if let Some(t) = &self.token {
            b = b.header("x-wisp-token", t);
        }
        let r = b.send().await.map_err(|e| CliError::said(format!("wisp at {}: {e}", self.url)))?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or_default();
        if v.get("ok") == Some(&Value::Bool(true)) {
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
        let message = v.pointer("/error/message").and_then(Value::as_str).map_or_else(|| format!("{cmd}: HTTP {status}"), str::to_owned);
        Err(CliError::Http { status, message, body: v })
    }

    /// The token this client sends (`WISP_TOKEN`), for the stream it opens itself.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.request("GET", path, None).await
    }

    pub async fn ping(&self) -> bool {
        self.get("/health").await.ok().and_then(|v| v.get("ok").and_then(Value::as_bool)) == Some(true)
    }

    /// The running wisp, else a headless one started now (v1 `WispClient.connect`).
    pub async fn connect(port: u16, start: bool) -> Result<Self> {
        let c = Self::new(port);
        if c.ping().await {
            return Ok(c);
        }
        if !start {
            return Err(CliError::said(format!("wisp is not running at {}", c.url)));
        }
        let exe = std::env::current_exe()?;
        let mut cmd = std::process::Command::new(exe);
        cmd.args(["--no-open", "--port", &port.to_string()]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        cmd.spawn()?;
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            if c.ping().await {
                return Ok(c);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Err(CliError::said(format!("wisp did not start at {}", c.url)))
    }
}
