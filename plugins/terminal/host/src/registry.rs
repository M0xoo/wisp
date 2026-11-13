//! The terminals that run, one per (kind, task): their PTY, state, kept output and watching pages.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::Ctx;
use wisp_kernel::http::{Response, StreamTx};
use wisp_proc::{ChildHandle, Env, Proc, PtySize, SpawnOpts};
use wisp_terminal_api::commands::OpenArgs;
use wisp_terminal_api::{InputOrder, TermInfo, TermKind, TermState};
use wisp_terminal_core::flow::{FlowEvent, SLOW_MS, exit_event, step};
use wisp_terminal_core::replay::{KEEP, Replay, Utf8Stream};
use wisp_terminal_core::size::{COLS, ROWS, clamp};
use wisp_terminal_core::{order, sse};

struct Term {
    info: TermInfo,
    handle: Option<ChildHandle>,
    replay: Replay,
    clients: Vec<StreamTx>,
    order: order::InputOrder,
}

type Key = (TermKind, String);

pub struct Registry {
    proc: Proc,
    map: Arc<Mutex<HashMap<Key, Term>>>,
    /// Preview's proxies (ADR-0049), under the plugin's scope: switched off, they stop
    pub proxies: crate::proxy::Proxies,
    pub scope: wisp_kernel::CancellationToken,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

/// Sends `frame` to every page; a page that went away is dropped.
fn broadcast(t: &mut Term, frame: &[u8]) {
    t.clients.retain(|c| c.try_send(frame.to_vec()).is_ok() || !c.is_closed());
    t.info.clients = u32::try_from(t.clients.len()).unwrap_or(u32::MAX);
}

impl Registry {
    pub fn new(proc: Proc, scope: wisp_kernel::CancellationToken) -> Self {
        Self { proc, map: Arc::new(Mutex::new(HashMap::new())), proxies: crate::proxy::Proxies::default(), scope }
    }

    pub fn info(&self, kind: TermKind, id: &str) -> Option<TermInfo> {
        lock(&self.map).get(&(kind, id.to_owned())).map(|t| t.info.clone())
    }

    pub fn live(&self, kind: TermKind, id: &str) -> bool {
        self.info(kind, id).is_some_and(|i| i.state.live())
    }

    /// The port the run's own output says the app listens on (v1 runs.js `r.url`), from its kept screen.
    pub fn local_port(&self, kind: TermKind, id: &str) -> Option<u16> {
        let mut m = lock(&self.map);
        let t = m.get_mut(&(kind, id.to_owned()))?;
        wisp_terminal_core::pick::local_port_in(t.replay.read())
    }

    /// Starts one, or answers the one that runs. A program that can't start is an answer (`failed`).
    pub fn open(&self, ctx: &Ctx, a: &OpenArgs) -> TermInfo {
        let key = (a.kind, a.id.clone());
        if let Some(t) = lock(&self.map).get(&key).filter(|t| t.info.state.live()) {
            return t.info.clone();
        }
        let (cols, rows) = (clamp(a.cols, COLS, COLS.default), clamp(a.rows, ROWS, ROWS.default));
        let at = now(ctx);
        let mut info = TermInfo { id: a.id.clone(), kind: a.kind, state: step(TermState::Idle, FlowEvent::Start), cols, rows, resizable: true, code: None, started_at: at, used_at: at, clients: 0, tui: a.tui };
        let patch = wisp_terminal_core::env::term_env(a.kind == TermKind::Takeover);
        let opts = SpawnOpts { cwd: Some(a.cwd.clone().into()), env: Env { clear: false, set: patch.set.clone(), remove: patch.remove.clone() }, pty: Some(PtySize { cols, rows }), ..SpawnOpts::default() };
        let mut replay = Replay::new(KEEP);
        // "" or a relative folder would start it in the server's own folder
        let no_dir = wisp_runtime_api::paths::Folder::of(&a.cwd).err();
        let spawned = match a.argv.split_first() {
            Some((p, rest)) if no_dir.is_none() => self.proc.spawn(p, rest, opts).ok(),
            _ => None,
        };
        let Some(child) = spawned else {
            // it never ran: wisp's line on its screen, code 127 (v1)
            info.state = step(info.state, FlowEvent::Fail);
            info.code = Some(127);
            let why = no_dir.map_or_else(String::new, |e| format!(" ({e})"));
            replay.push(&format!("wisp: couldn't start {}{why}\r\n", a.argv.first().map_or("", String::as_str)));
            lock(&self.map).insert(key, Term { info: info.clone(), handle: None, replay, clients: Vec::new(), order: order::InputOrder::new() });
            return info;
        };
        let (handle, mut rx) = child.split();
        lock(&self.map).insert(key.clone(), Term { info: info.clone(), handle: Some(handle.clone()), replay, clients: Vec::new(), order: order::InputOrder::new() });
        let map = self.map.clone();
        // a slow start says so (#440)
        if let Ok(clock) = ctx.clock() {
            let (map, key) = (map.clone(), key.clone());
            ctx.spawn(async move {
                clock.sleep(SLOW_MS).await;
                if let Some(t) = lock(&map).get_mut(&key).filter(|t| t.info.state == TermState::Starting) {
                    t.info.state = step(t.info.state, FlowEvent::Slow);
                }
            });
        }
        let started = at;
        let ectx = ctx.clone();
        ctx.spawn(async move {
            let mut utf8 = Utf8Stream::new();
            while let Some(o) = rx.recv().await {
                let text = utf8.decode(&o.data);
                if text.is_empty() {
                    continue;
                }
                let mut m = lock(&map);
                let Some(t) = m.get_mut(&key) else { return };
                if t.info.started_at != started {
                    return; // a newer terminal took its place
                }
                t.info.state = step(t.info.state, FlowEvent::Ready);
                t.replay.push(&text);
                broadcast(t, &sse::data(&text));
            }
            let exit = handle.exited().await;
            let code = exit.code.unwrap_or(-1);
            let ended = {
                let mut m = lock(&map);
                m.get_mut(&key).filter(|t| t.info.started_at == started).map(|t| {
                    t.info.state = step(t.info.state, exit_event(t.info.state, code));
                    t.info.code = Some(code);
                    t.handle = None;
                    broadcast(t, &sse::exit(Some(code)));
                    t.clients.clear();
                    t.info.clients = 0;
                    t.info.state
                })
            };
            // ended on its own (a take over's CLI quit): whoever owns the task hears it
            if let Some(state) = ended {
                ectx.emit(&ectx.root_call(), &wisp_terminal_api::Changed { kind: key.0, id: key.1.clone(), state, code: Some(code), gone: false });
                // the app exited by itself: its row says Run app again
                if key.0 == TermKind::Run {
                    crate::mark_run(&ectx, &ectx.root_call(), &key.1, false).await;
                }
            }
        });
        info
    }

    /// A page watches it: the size, the screen so far, then the output as it comes (v1 `attach`).
    pub fn attach(&self, kind: TermKind, id: &str) -> Response {
        let (tx, res) = Response::sse();
        let mut m = lock(&self.map);
        let Some(t) = m.get_mut(&(kind, id.to_owned())) else {
            let _ = tx.try_send(sse::GONE.to_vec());
            return res;
        };
        let _ = tx.try_send(sse::hello(t.info.cols, t.info.rows, t.info.resizable, t.info.state));
        let screen = t.replay.read().to_owned();
        let _ = tx.try_send(sse::data(&screen)); // always, even empty: the page replays it
        if let Some(code) = t.info.code {
            let _ = tx.try_send(sse::exit(Some(code)));
            return res;
        }
        t.clients.push(tx);
        t.info.clients = u32::try_from(t.clients.len()).unwrap_or(u32::MAX);
        res
    }

    /// Typed keys; numbered ones (seq per page) go in in order, a gap skipped after a while.
    pub fn input(&self, kind: TermKind, id: &str, data: &str, o: &InputOrder, ctx: &Ctx) -> bool {
        let mut m = lock(&self.map);
        let Some(t) = m.get_mut(&(kind, id.to_owned())).filter(|t| t.info.state.live()) else { return false };
        let at = now(ctx);
        t.info.used_at = at;
        let parts = match (o.seq, o.from.as_deref()) {
            (Some(seq), Some(from)) => t.order.put(data.to_owned(), seq, from, at),
            _ => vec![data.to_owned()],
        };
        if let Some(h) = &t.handle {
            for p in parts {
                let _ = h.write(p.into_bytes());
            }
        }
        true
    }

    pub fn resize(&self, kind: TermKind, id: &str, cols: Option<f64>, rows: Option<f64>) -> bool {
        let (Some(_), Some(_)) = (cols, rows) else { return false };
        let mut m = lock(&self.map);
        let Some(t) = m.get_mut(&(kind, id.to_owned())).filter(|t| t.info.state.live()) else { return false };
        t.info.cols = clamp(cols, COLS, t.info.cols);
        t.info.rows = clamp(rows, ROWS, t.info.rows);
        t.handle.as_ref().is_some_and(|h| h.resize(PtySize { cols: t.info.cols, rows: t.info.rows }).is_ok())
    }

    /// Hangs it up (a start in progress is cancelled, never raced: #435); the registry forgets it.
    pub async fn close(&self, kind: TermKind, id: &str) -> bool {
        let t = lock(&self.map).remove(&(kind, id.to_owned()));
        let Some(mut t) = t else { return false };
        t.info.state = step(t.info.state, FlowEvent::Stop);
        broadcast(&mut t, &sse::exit(None));
        if let Some(h) = t.handle.take() {
            let _ = h.kill().await;
        }
        true
    }
}
