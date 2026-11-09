//! hostd's process driver (v1 grid/hostd.js `process`): one `wisp serve` per user on this machine, with its
//! own `WISP_HOME` and `HOME`, in box mode (`WISP_BOX=1`: the `box` set, `BoxPlugins`) and trusted-proxy
//! mode (a random secret per start that only the edge sends). For development and one trusted team: the
//! users share an OS user, so it is not isolation between them (the container driver is, v1 boxd: not
//! ported yet).
//!
//! - **Use:** `ensure` (unless `wake`) and a `begin(…, true)` guard count as use; a passive request never
//!   gets here (the edge answers it asleep), so watching a box never wakes or keeps it up.
//! - **Idle:** every `checkMs`, a running box with no request open, nothing going on (its `/api/status`:
//!   no turn, side question, terminal or channel at work) and no use for `idleMs` is stopped. Its home stays.
//! - **One start:** several callers waiting on a stopped box share one start.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::broadcast;

use crate::boxhost::{BoxChange, BoxHost, BoxState, BoxUserWire, Busy, Running};
use crate::clock::SharedClock;
use crate::error::{Result, bad};
use crate::rows::BoxUser;

#[derive(Clone)]
pub struct ProcessOptions {
    /// the wisp binary
    pub bin: PathBuf,
    /// homes go under `<data>/users/<id>/`
    pub data: PathBuf,
    pub idle_ms: i64,
    pub check_ms: i64,
    pub start_ms: i64,
    pub max_running: usize,
    /// more environment for every box (the operator's choice: a harness's path, a test's fakes)
    pub env: Vec<(String, String)>,
    /// `<handle>` → the box's public URL (`WISP_PUBLIC_URL`)
    pub url_of: Arc<dyn Fn(&str) -> String + Send + Sync>,
}


impl std::fmt::Debug for ProcessOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessOptions").field("bin", &self.bin).field("data", &self.data).finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
struct Inst {
    state: BoxState,
    port: Option<u16>,
    secret: String,
    child: Option<tokio::process::Child>,
    last_touch: i64,
    inflight: usize,
    started_at: Option<i64>,
    stopped_at: Option<i64>,
}

#[derive(Debug)]
pub struct ProcessHost {
    o: ProcessOptions,
    clock: SharedClock,
    inst: Arc<Mutex<HashMap<String, Inst>>>,
    starts: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    tx: broadcast::Sender<BoxChange>,
    peak: Mutex<(usize, usize)>,
    http: reqwest::Client,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A port nobody listens on, now.
fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| bad(format!("no free port: {e}"), 503))?;
    Ok(l.local_addr().map_err(|e| bad(e.to_string(), 503))?.port())
}

impl ProcessHost {
    pub fn new(o: ProcessOptions, clock: SharedClock) -> Arc<Self> {
        let (tx, _) = broadcast::channel(64);
        let http = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(2)).build().unwrap_or_default();
        let h = Arc::new(Self { o, clock, inst: Arc::new(Mutex::new(HashMap::new())), starts: Mutex::new(HashMap::new()), tx, peak: Mutex::new((0, 0)), http });
        let me = Arc::downgrade(&h);
        let every = Duration::from_millis(u64::try_from(h.o.check_ms.max(200)).unwrap_or(5000));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(h) = me.upgrade() else { return };
                h.check_idle().await;
            }
        });
        h
    }

    /// Stop every box (the grid is stopping).
    pub async fn close_all(&self) {
        BoxHost::close(self).await;
    }

    /// The secret the edge sends this box as `x-wisp-proxy-secret` (none while it's stopped).
    pub fn secret(&self, user_id: &str) -> Option<String> {
        lock(&self.inst).get(user_id).filter(|i| i.state == BoxState::Running).map(|i| i.secret.clone())
    }

    fn change(&self, user: &BoxUser, state: BoxState, event: &str) {
        let (started_at, stopped_at, last) = lock(&self.inst).get(&user.id).map_or((None, None, None), |i| (i.started_at, i.stopped_at, Some(i.last_touch)));
        let _ = self.tx.send(BoxChange { user: BoxUserWire::from(user), state, event: event.into(), started_at, stopped_at, next_wake_at: None, last_active_at: last, error: String::new() });
    }

    async fn check_idle(&self) {
        let now = self.clock.now_ms();
        let quiet: Vec<(String, u16, i64)> = lock(&self.inst).iter().filter(|(_, i)| i.state == BoxState::Running && i.inflight == 0 && now - i.last_touch > self.o.idle_ms).filter_map(|(id, i)| i.port.map(|p| (id.clone(), p, i.last_touch))).collect();
        for (id, port, touched) in quiet {
            let s: serde_json::Value = match self.http.get(format!("http://127.0.0.1:{port}/api/status")).send().await {
                Ok(r) => r.json().await.unwrap_or_default(),
                Err(_) => serde_json::Value::Null,
            };
            let n = |k: &str| s.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
            let busy = n("live") + n("sides") + n("terms") + n("channels") > 0;
            let last = s.get("lastActivityAt").and_then(serde_json::Value::as_i64).unwrap_or(0).max(touched);
            if !busy && now - last > self.o.idle_ms {
                tracing::info!("hostd: {id} idle, stopping");
                let _ = self.stop(&id, "idle").await;
            }
        }
    }

    async fn start(&self, user: &BoxUser) -> Result<Running> {
        let running = lock(&self.inst).values().filter(|i| i.state == BoxState::Running).count();
        if running >= self.o.max_running {
            let mut p = lock(&self.peak);
            p.1 += 1;
            return Err(bad("This grid is full right now. Try again in a few minutes.", 503));
        }
        let port = free_port()?;
        let secret = crate::accounts::token("");
        let base = self.o.data.join("users").join(&user.id);
        let home = base.join("home");
        std::fs::create_dir_all(&home).map_err(|e| bad(format!("the box's home: {e}"), 500))?;
        let mut cmd = tokio::process::Command::new(&self.o.bin);
        cmd.arg("serve")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &base)
            .env("WISP_HOME", &home)
            .env("WISP_PORT", port.to_string())
            .env("WISP_BOX", "1")
            .env("WISP_TRUSTED_PROXY_SECRET", &secret)
            .env("WISP_PUBLIC_URL", (self.o.url_of)(&user.handle))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::fs::File::create(base.join("wisp.log")).map_or_else(|_| std::process::Stdio::null(), std::process::Stdio::from))
            .kill_on_drop(true);
        for (k, v) in &self.o.env {
            cmd.env(k, v);
        }
        {
            let mut m = lock(&self.inst);
            let i = m.entry(user.id.clone()).or_default();
            i.state = BoxState::Starting;
        }
        self.change(user, BoxState::Starting, "starting");
        let child = cmd.spawn().map_err(|e| bad(format!("wisp didn't start in the box: {e}"), 503))?;
        let deadline = self.clock.now_ms() + self.o.start_ms;
        let mut child = Some(child);
        loop {
            if self.http.get(format!("http://127.0.0.1:{port}/api/health")).send().await.is_ok_and(|r| r.status().is_success()) {
                break;
            }
            if let Some(c) = child.as_mut()
                && let Ok(Some(st)) = c.try_wait()
            {
                lock(&self.inst).entry(user.id.clone()).or_default().state = BoxState::Stopped;
                self.change(user, BoxState::Stopped, "failed");
                return Err(bad(format!("wisp in the box stopped as it started ({st})."), 503));
            }
            if self.clock.now_ms() > deadline {
                lock(&self.inst).entry(user.id.clone()).or_default().state = BoxState::Stopped;
                self.change(user, BoxState::Stopped, "failed");
                return Err(bad("wisp in the box didn't answer in time.", 504));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let now = self.clock.now_ms();
        {
            let mut m = lock(&self.inst);
            let i = m.entry(user.id.clone()).or_default();
            (i.state, i.port, i.secret, i.child, i.started_at, i.last_touch) = (BoxState::Running, Some(port), secret, child.take(), Some(now), now);
            let up = m.values().filter(|i| i.state == BoxState::Running).count();
            let mut p = lock(&self.peak);
            p.0 = p.0.max(up);
        }
        self.change(user, BoxState::Running, "woke");
        Ok(Running { port })
    }
}

#[async_trait::async_trait]
impl BoxHost for ProcessHost {
    fn state(&self, user_id: &str) -> BoxState {
        lock(&self.inst).get(user_id).map_or(BoxState::Stopped, |i| i.state)
    }
    fn port(&self, user_id: &str) -> Option<u16> {
        lock(&self.inst).get(user_id).filter(|i| i.state == BoxState::Running).and_then(|i| i.port)
    }
    fn touch(&self, user_id: &str) {
        let now = self.clock.now_ms();
        if let Some(i) = lock(&self.inst).get_mut(user_id) {
            i.last_touch = i.last_touch.max(now);
        }
    }
    fn begin(&self, user_id: &str, touch: bool) -> Busy {
        match lock(&self.inst).get_mut(user_id) {
            Some(i) => i.inflight += 1,
            None => return Busy::none(),
        }
        // the guard finds the box again by id when the request ends
        let (inst, id, clock) = (self.inst.clone(), user_id.to_owned(), self.clock.clone());
        Busy::new(move || {
            if let Some(i) = lock(&inst).get_mut(&id) {
                i.inflight = i.inflight.saturating_sub(1);
                if touch {
                    i.last_touch = i.last_touch.max(clock.now_ms());
                }
            }
        })
    }
    async fn ensure(&self, user: &BoxUser, wake: bool) -> Result<Running> {
        let gate = lock(&self.starts).entry(user.id.clone()).or_default().clone();
        let _one = gate.lock().await;
        if let Some(port) = self.port(&user.id) {
            if !wake {
                self.touch(&user.id);
            }
            return Ok(Running { port });
        }
        self.start(user).await
    }
    async fn stop(&self, user_id: &str, reason: &str) -> Result<bool> {
        let child = {
            let mut m = lock(&self.inst);
            let Some(i) = m.get_mut(user_id).filter(|i| i.state == BoxState::Running) else { return Ok(false) };
            i.state = BoxState::Stopping;
            i.child.take()
        };
        if let Some(mut c) = child {
            let _ = c.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(10), c.wait()).await;
        }
        let now = self.clock.now_ms();
        {
            let mut m = lock(&self.inst);
            if let Some(i) = m.get_mut(user_id) {
                (i.state, i.port, i.stopped_at) = (BoxState::Stopped, None, Some(now));
                i.secret.clear();
            }
        }
        let user = BoxUser { id: user_id.to_owned(), handle: String::new(), sandbox: None, owner: None };
        self.change(&user, BoxState::Stopped, reason);
        Ok(true)
    }
    async fn remove(&self, user: &BoxUser) -> Result<()> {
        self.stop(&user.id, "deleted").await?;
        let _ = tokio::fs::remove_dir_all(self.o.data.join("users").join(&user.id)).await;
        lock(&self.inst).remove(&user.id);
        Ok(())
    }
    fn restore(&self, _user: &BoxUser, _next_wake_at: Option<i64>) {}
    fn capacity(&self) -> usize {
        self.o.max_running
    }
    fn take_peak(&self) -> (usize, usize) {
        std::mem::take(&mut *lock(&self.peak))
    }
    fn changes(&self) -> broadcast::Receiver<BoxChange> {
        self.tx.subscribe()
    }
    fn previews(&self) -> bool {
        false
    }
    async fn close(&self) {
        let ids: Vec<String> = lock(&self.inst).keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id, "grid stopped").await;
        }
    }
}
