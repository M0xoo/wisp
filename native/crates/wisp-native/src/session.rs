//! One request at a time, from the server: dispatch, and the shutdown sweep when it goes away.

use std::thread;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::PtySize;
use wisp_native_sys as sys;

use crate::child;
use crate::error::{Error, Result};
use crate::out::Out;
use crate::protocol::{Event, Request};
use crate::registry::{self, Input, Shared};
use crate::tree;

/// SIGTERM's grace before SIGKILL, unless the request names one.
const GRACE: Duration = Duration::from_secs(2);
/// On shutdown the server is already gone; programs get less time to tidy up.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);
/// The longest grace a request may ask for.
const MAX_GRACE: Duration = Duration::from_secs(60);

/// Handle one line from stdin. Errors go back as `error` events; nothing here ends the helper.
pub fn handle(line: &str, reg: &Shared, out: &Out) {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return out.send(Event::error(None, None, &Error::BadRequest(e.to_string()))),
    };
    let span = tracing::info_span!("cmd", op = req.op(), id = req.id().unwrap_or(""));
    let _entered = span.enter();
    let id = req.id().map(str::to_owned);
    let reference = match &req {
        Request::Kill { reference, .. } | Request::List { reference } => reference.clone(),
        _ => None,
    };
    if let Err(e) = dispatch(req, reg, out) {
        tracing::debug!(error = %e, "refused");
        out.send(Event::error(id, reference, &e));
    }
}

fn dispatch(req: Request, reg: &Shared, out: &Out) -> Result<()> {
    match req {
        Request::Spawn(spawn) => child::spawn(spawn, reg, out).map(|_| ()),
        Request::Data { id, data } => {
            let bytes = B64.decode(data.as_bytes()).map_err(|e| Error::BadRequest(format!("data: {e}")))?;
            send_input(reg, &id, Input::Bytes(bytes))
        }
        Request::Eof { id } => {
            let mut r = registry::lock(reg);
            let entry = r.live(&id)?;
            if let Some(tx) = entry.input.take() {
                let _ = tx.send(Input::Eof);
            }
            Ok(())
        }
        Request::Resize { id, cols, rows } => {
            let mut r = registry::lock(reg);
            let master = r.live(&id)?.master.as_ref().ok_or(Error::Unsupported("resize without a pty"))?;
            let size = PtySize { cols: cols.max(1), rows: rows.max(1), ..PtySize::default() };
            master.resize(size).map_err(|e| Error::Io(std::io::Error::other(e.to_string())))
        }
        Request::Signal { id, signal, tree } => {
            let sig = signal_number(&signal)?;
            let target = registry::lock(reg).target(&id)?;
            tree::signal(&target.tree, target.alive, sig, tree).map_err(Error::Io)
        }
        Request::Kill { id, tree, signal, grace_ms, reference } => {
            let sig = signal.as_deref().map_or(Ok(sys::SIGTERM), signal_number)?;
            let grace = grace_ms.map_or(GRACE, Duration::from_millis).min(MAX_GRACE);
            let target = registry::lock(reg).target(&id)?;
            let out = out.clone();
            let span = tracing::Span::current();
            thread::Builder::new().name(format!("kill-{id}")).spawn(move || {
                let _entered = span.enter();
                let report = if tree {
                    tree::kill(&target.tree, target.alive, sig, grace)
                } else {
                    let ok = tree::signal(&target.tree, target.alive, sig, false).is_ok();
                    tree::Report { signalled: usize::from(ok), survivors: 0 }
                };
                tracing::info!(signalled = report.signalled, survivors = report.survivors, "killed");
                out.send(Event::Killed { id, reference, signalled: report.signalled, survivors: report.survivors });
            })?;
            Ok(())
        }
        Request::List { reference } => {
            let items = registry::lock(reg).items();
            out.send(Event::List { reference, items });
            Ok(())
        }
    }
}

fn signal_number(name: &str) -> Result<i32> {
    sys::signal_number(name).ok_or_else(|| Error::BadRequest(format!("unknown signal {name}")))
}

fn send_input(reg: &Shared, id: &str, input: Input) -> Result<()> {
    let mut r = registry::lock(reg);
    let entry = r.live(id)?;
    let tx = entry.input.as_ref().ok_or_else(|| Error::BadRequest(format!("stdin of {id:?} is closed")))?;
    tx.send(input).map_err(|_| Error::Exited(id.to_owned()))
}

/// The server closed our stdin (it exited, or crashed): end every tree we started, so nothing
/// outlives it. Trees are killed side by side, so this takes one grace period, not one per child.
pub fn shutdown(reg: &Shared) {
    let targets = registry::lock(reg).targets();
    tracing::info!(trees = targets.len(), "shutdown");
    thread::scope(|s| {
        for t in &targets {
            s.spawn(move || tree::kill(&t.tree, t.alive, sys::SIGTERM, SHUTDOWN_GRACE));
        }
    });
}
