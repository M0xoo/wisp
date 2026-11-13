//! The grid's side of boxd (v1 grid/boxd.js `boxdCall`, `boxdRun`): boxd runs each user's box as a container, as
//! root, over a Unix socket only the grid's group can open (`apps/grid/boxd`). A run's connection stays open while
//! its box runs; boxd streams its output (to the box's log file here) and its exit. Dropping the [`BoxdRun`] closes
//! the connection, which stops the box.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, watch};

use crate::error::{Result, bad};

/// The container driver's settings, from `hostd.container`: boxd's socket and the limits a run asks for (boxd checks
/// them against its own; image, runtime and network are boxd's).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Driver {
    pub socket: PathBuf,
    /// `{memory, memorySwap, cpus, pids}`, or null for boxd's
    pub limits: Value,
    pub dns: Option<Vec<String>>,
}

impl Driver {
    pub fn of(c: &crate::config::ContainerConfig) -> Option<Self> {
        let socket = c.boxd.as_ref().filter(|s| !s.is_empty())?;
        let mut limits = serde_json::Map::new();
        for (k, v) in [
            ("memory", c.memory.clone().map(Value::from)),
            ("memorySwap", c.memory_swap.clone().map(Value::from)),
            ("cpus", c.cpus.map(Value::from)),
            ("pids", c.pids.map(Value::from)),
        ] {
            if let Some(v) = v {
                limits.insert(k.into(), v);
            }
        }
        Some(Self {
            socket: socket.into(),
            limits: if limits.is_empty() { Value::Null } else { Value::Object(limits) },
            dns: c.dns.clone(),
        })
    }
}

fn unreachable(socket: &Path, e: &dyn std::fmt::Display) -> String {
    format!("boxd didn't answer at {} ({e}): is wisp-grid-boxd running?", socket.display())
}

/// One request and its answer (`ping`, `remove`); boxd's `error` becomes an error.
pub async fn call(socket: &Path, req: &Value) -> Result<Value> {
    let go = async {
        let mut s = UnixStream::connect(socket).await.map_err(|e| bad(unreachable(socket, &e), 503))?;
        s.write_all(format!("{req}\n").as_bytes()).await.map_err(|e| bad(unreachable(socket, &e), 503))?;
        let mut lines = BufReader::new(s).lines();
        let mut answer = Value::Null;
        while let Ok(Some(l)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&l) {
                answer = v;
            }
        }
        if let Some(e) = answer.get("error").and_then(Value::as_str) {
            return Err(bad(e.to_owned(), 502));
        }
        if answer.is_null() {
            return Err(bad(unreachable(socket, &"no answer"), 503));
        }
        Ok(answer)
    };
    tokio::time::timeout(std::time::Duration::from_secs(60), go).await.map_err(|_| bad(unreachable(socket, &"no answer in time"), 504))?
}

/// A box boxd runs, watched like a child process: its exit, a signal, and what boxd said when it couldn't start it.
#[derive(Debug)]
pub struct BoxdRun {
    control: mpsc::UnboundedSender<String>,
    exit: watch::Receiver<Option<String>>,
    error: Arc<Mutex<String>>,
}

impl BoxdRun {
    /// Starts the box; its output goes to `log`.
    pub async fn start(socket: &Path, mut req: Value, log: PathBuf) -> Result<Self> {
        let s = UnixStream::connect(socket).await.map_err(|e| bad(unreachable(socket, &e), 503))?;
        let (rd, mut wr) = s.into_split();
        req["op"] = json!("run");
        wr.write_all(format!("{req}\n").as_bytes()).await.map_err(|e| bad(unreachable(socket, &e), 503))?;
        let (control, mut rx) = mpsc::unbounded_channel::<String>();
        let (tx, exit) = watch::channel(None);
        let error = Arc::new(Mutex::new(String::new()));
        // what the grid sends while it runs; when this ends (the BoxdRun is dropped) the connection closes
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if wr.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
            let _ = wr.shutdown().await;
        });
        let err2 = error.clone();
        let sock = socket.to_owned();
        tokio::spawn(async move {
            let mut out = tokio::fs::OpenOptions::new().create(true).append(true).open(&log).await.ok();
            let mut lines = BufReader::new(rd).lines();
            let mut ended = None;
            while let Ok(Some(l)) = lines.next_line().await {
                let Ok(m) = serde_json::from_str::<Value>(&l) else { continue };
                if let Some(t) = m.get("log").and_then(Value::as_str) {
                    if let Some(f) = out.as_mut() {
                        let _ = f.write_all(t.as_bytes()).await;
                    }
                } else if let Some(e) = m.get("error").and_then(Value::as_str) {
                    e.clone_into(&mut err2.lock().unwrap_or_else(PoisonError::into_inner));
                    if let Some(f) = out.as_mut() {
                        let _ = f.write_all(format!("boxd: {e}\n").as_bytes()).await;
                    }
                } else if m.get("exit").is_some() {
                    ended = Some(format!(
                        "exit {}{}",
                        m["exit"],
                        m.get("signal").and_then(Value::as_str).map(|s| format!(" ({s})")).unwrap_or_default()
                    ));
                    break;
                }
            }
            if ended.is_none() {
                let mut e = err2.lock().unwrap_or_else(PoisonError::into_inner);
                if e.is_empty() {
                    *e = unreachable(&sock, &"the connection closed");
                }
            }
            let _ = tx.send(Some(ended.unwrap_or_else(|| "exit 1".into())));
        });
        Ok(Self { control, exit, error })
    }

    /// It ended: how (`exit 0`, `exit 137 (signal 9)`), or None while it runs.
    pub fn exited(&self) -> Option<String> {
        self.exit.borrow().clone()
    }

    /// What boxd said when it couldn't start it.
    pub fn error(&self) -> String {
        self.error.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn signal(&self, sig: &str) -> bool {
        self.control.send(format!("{}\n", json!({ "signal": sig }))).is_ok()
    }

    /// TERM, then KILL after `grace`; returns once it's gone.
    pub async fn stop(mut self, grace: std::time::Duration) {
        self.signal("SIGTERM");
        let gone = tokio::time::timeout(grace, self.exit.wait_for(Option::is_some)).await.is_ok();
        if !gone {
            self.signal("SIGKILL");
            let _ = tokio::time::timeout(grace, self.exit.wait_for(Option::is_some)).await;
        }
    }
}
