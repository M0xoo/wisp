//! wisp-native: the PTY and process-tree helper of the wisp server (plan §0.2 item 1, ADR-0010).
//!
//! The server starts one helper and talks to it over stdio, one JSON object per line
//! (PROTOCOL.md). The helper's stdin is its leash: when it closes, every tree the helper started
//! is killed and the helper exits. Logs go to stderr (`WISP_NATIVE_LOG=debug`); stdout is the
//! protocol.

mod child;
mod error;
mod input;
mod out;
mod protocol;
mod registry;
mod session;
mod tree;

use std::io::{self, BufRead as _};
use std::process::ExitCode;
use std::time::Duration;

use crate::out::Out;
use crate::protocol::Event;
use crate::registry::Registry;

fn main() -> ExitCode {
    init_tracing();
    let (out, _writer) = match Out::start() {
        Ok(o) => o,
        Err(e) => {
            tracing::error!(error = %e, "can't start the output thread");
            return ExitCode::FAILURE;
        }
    };
    if std::env::args().nth(1).as_deref() == Some("--version") {
        // For `wisp doctor` and the release smoke test; still one JSON line.
        out.send(Event::hello());
        out.flush(Duration::from_secs(1));
        return ExitCode::SUCCESS;
    }
    let reg = Registry::shared();
    out.send(Event::hello());
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if !line.trim().is_empty() {
            session::handle(&line, &reg, &out);
        }
    }
    session::shutdown(&reg);
    out.flush(Duration::from_secs(1));
    // Reader threads may be blocked on a terminal a stray process still holds; don't join them.
    std::process::exit(0)
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("WISP_NATIVE_LOG").unwrap_or_else(|_| EnvFilter::new("warn"));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(io::stderr).with_ansi(false).with_target(false).init();
}
