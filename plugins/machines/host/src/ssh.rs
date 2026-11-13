//! The `ssh` transport (plan §7.2.2): the system's OpenSSH through the proc service, so
//! `~/.ssh/config`, agents, `ProxyJump` and FIDO keys all work. One `ssh -L <local>:127.0.0.1:<port>
//! <target> sh -s` per connection: the bootstrap (core `bootstrap.sh`) goes in on stdin, installs
//! wisp's release binary there when it isn't, starts `wisp serve --port <port>`, and holds the session
//! (and the forward) open. The channel is plain HTTP to the forward's local end.
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use wisp_kernel::{BoxFuture, CancellationToken, Ctx};
use wisp_machines_api::{
    AddArgs, Channel, ChannelEnd, Cleaned, ConnectIo, EndReason, Failing, LetInOut, PeerRow, StepStatus, Stopped, Transport,
    TransportFailure,
};
use wisp_machines_core::bootstrap::{self, Api, BootLine, BootOpts, TUNNEL};
use wisp_machines_core::conn::{READY_TIMEOUT_MS, TOO_LONG, no_ssh};
use wisp_machines_core::{hint, ssh, view};
use wisp_proc::{ChildHandle, Output, Proc, SpawnOpts, Stream};

use crate::http::HttpChannel;

pub const SSH_BIN: &str = "ssh";

#[derive(Debug)]
pub struct SshTransport {
    pub ctx: Ctx,
    pub version: String,
}

fn proc_of(ctx: &Ctx) -> Failing<Proc> {
    ctx.service::<Proc>().map(|p| p.as_ref().clone()).map_err(|e| TransportFailure::new(e.message).final_())
}

/// A free port on this computer for the forward's local end (ssh exits if it is taken meanwhile).
async fn free_port() -> Failing<u16> {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| TransportFailure::new(format!("No free local port: {e}")))?;
    l.local_addr().map(|a| a.port()).map_err(|e| TransportFailure::new(e.to_string()))
}

/// Why ssh ended before wisp was ready: its last line, and what that most likely needs.
fn ended_early(code: Option<i32>, stderr: &str, target: &str) -> TransportFailure {
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).map(str::trim);
    let msg = last.map_or_else(|| format!("ssh exited ({}).", code.map_or_else(|| "signal".into(), |c| c.to_string())), str::to_owned);
    TransportFailure { hint: hint::ssh_hint(stderr, target), ..TransportFailure::new(msg) }
}

/// Lines of the bootstrap's stdout, split as they come (a chunk may end mid-line).
#[derive(Debug, Default)]
struct Lines(String);

impl Lines {
    fn push(&mut self, data: &[u8]) -> Vec<String> {
        self.0.push_str(&String::from_utf8_lossy(data));
        let mut out = Vec::new();
        while let Some(i) = self.0.find('\n') {
            out.push(self.0[..i].trim_end_matches('\r').to_owned());
            self.0.drain(..=i);
        }
        out
    }
}

/// One bootstrap line: `Some(Ok)` ready, `Some(Err)` failed for good, `None` keep reading.
fn on_line(io: &dyn ConnectIo, line: &str) -> Option<Failing<()>> {
    match bootstrap::parse_line(line) {
        BootLine::Blank => None,
        BootLine::Log(l) => {
            io.log(&l);
            None
        }
        BootLine::Step { id, status, detail } => {
            io.log(&format!("{id}: {detail}"));
            io.step(&id, status, Some(&detail));
            None
        }
        BootLine::Stale(pid) => {
            io.stale(pid);
            None
        }
        BootLine::Fail { id, message } => {
            io.step(&id, StepStatus::Fail, Some(&message));
            Some(Err(TransportFailure { hint: hint::step_hint(&id), ..TransportFailure::new(message).final_() }))
        }
        BootLine::Ready { .. } => {
            io.step(TUNNEL, StepStatus::Run, None);
            Some(Ok(()))
        }
    }
}

/// Reads the bootstrap until wisp is ready there, it fails, ssh exits or it takes too long.
async fn until_ready(
    child: &ChildHandle,
    out: &mut mpsc::Receiver<Output>,
    io: &dyn ConnectIo,
    stderr: &mut String,
    target: &str,
    cancel: &CancellationToken,
) -> Failing<()> {
    let mut lines = Lines::default();
    let deadline = tokio::time::sleep(Duration::from_millis(READY_TIMEOUT_MS));
    tokio::pin!(deadline);
    loop {
        let o = tokio::select! {
            () = cancel.cancelled() => return Err(TransportFailure::new("Disconnected.").final_()),
            () = &mut deadline => return Err(TransportFailure::new(TOO_LONG)),
            o = out.recv() => o,
        };
        let Some(o) = o else {
            let exit = child.exited().await;
            return Err(ended_early(exit.code, stderr, target));
        };
        if o.stream == Stream::Stderr {
            let text = String::from_utf8_lossy(&o.data);
            text.lines().filter(|l| !l.trim().is_empty()).for_each(|l| io.log(l));
            stderr.push_str(&text);
            continue;
        }
        for l in lines.push(&o.data) {
            if let Some(r) = on_line(io, &l) {
                return r;
            }
        }
    }
}

/// After ready: the rest of ssh's output goes to the log; its exit ends the channel (and says why).
async fn hold(
    child: ChildHandle,
    mut out: mpsc::Receiver<Output>,
    ch: Arc<HttpChannel>,
    io: Arc<dyn ConnectIo>,
    mut stderr: String,
    target: String,
) {
    let scope = ch.scope().clone();
    loop {
        tokio::select! {
            () = scope.cancelled() => {
                let _ = child.kill().await;
                return;
            }
            o = out.recv() => match o {
                Some(o) => {
                    let text = String::from_utf8_lossy(&o.data).into_owned();
                    text.lines().filter(|l| !l.trim().is_empty()).for_each(|l| io.log(l));
                    if o.stream == Stream::Stderr {
                        stderr.push_str(&text);
                    }
                }
                None => break,
            },
        }
    }
    let exit = child.exited().await;
    let f = ended_early(exit.code, &stderr, &target);
    ch.end_with(ChannelEnd { reason: EndReason::Lost, error: Some(f.message), hint: f.hint, give_up: false });
}

async fn connect(ctx: Ctx, version: String, peer: PeerRow, io: Arc<dyn ConnectIo>, cancel: CancellationToken) -> Failing<Arc<dyn Channel>> {
    let proc = proc_of(&ctx)?;
    let local = free_port().await?;
    let args = ssh::connect_args(&peer.address, local, peer.port);
    let opts = SpawnOpts { scope: Some(cancel.clone()), ..SpawnOpts::default() };
    let child = proc.spawn(SSH_BIN, &args, opts).map_err(|e| {
        let (msg, hint) = no_ssh(&e.to_string());
        TransportFailure { hint: Some(hint), ..TransportFailure::new(msg).final_() }
    })?;
    let (child, mut out) = child.split();
    let script = bootstrap::bootstrap_script(&BootOpts {
        port: peer.port,
        command: &peer.command,
        api: Api::Any,
        install: true,
        version: &version,
        dist: None,
    });
    child.write(script.into_bytes()).map_err(|e| TransportFailure::new(e.to_string()))?;
    let mut stderr = String::new();
    if let Err(f) = until_ready(&child, &mut out, io.as_ref(), &mut stderr, &peer.address, &cancel).await {
        let _ = child.kill().await;
        return Err(f);
    }
    let ch = HttpChannel::new(format!("http://127.0.0.1:{local}/api"), format!("localhost:{local} → {}", peer.port), cancel.child_token());
    tokio::spawn(hold(child, out, ch.clone(), io, stderr, peer.address.clone()));
    Ok(ch)
}

impl Transport for SshTransport {
    fn kind(&self) -> &str {
        wisp_machines_api::SSH
    }
    fn steps(&self) -> &'static [(&'static str, &'static str)] {
        bootstrap::STEPS
    }
    fn clean(&self, input: &AddArgs, prev: Option<&PeerRow>) -> Failing<Cleaned> {
        view::clean_ssh(input, prev).map_err(|m| TransportFailure { status: Some(400), ..TransportFailure::new(m) })
    }
    fn connect(&self, peer: PeerRow, io: Arc<dyn ConnectIo>, cancel: CancellationToken) -> BoxFuture<'static, Failing<Arc<dyn Channel>>> {
        Box::pin(connect(self.ctx.clone(), self.version.clone(), peer, io, cancel))
    }
    fn stop_remote(&self, peer: PeerRow, pid: Option<u32>, _io: Arc<dyn ConnectIo>) -> BoxFuture<'static, Failing<Stopped>> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let pid = pid.ok_or_else(|| TransportFailure {
                status: Some(409),
                ..TransportFailure::new(format!("wisp’s process on {} isn’t known yet: connect first.", peer.name))
            })?;
            let proc = proc_of(&ctx)?;
            let args = ssh::run_args(&peer.address, &ssh::kill_command(pid));
            let opts = wisp_proc::ExecOpts {
                timeout: Some(Duration::from_secs(30)),
                scope: Some(ctx.scope().clone()),
                ..wisp_proc::ExecOpts::default()
            };
            let r = proc.exec(SSH_BIN, &args, opts).await.map_err(|e| TransportFailure::new(e.to_string()))?;
            if r.exit.success() {
                Ok(Stopped::Off)
            } else {
                Err(TransportFailure { status: Some(502), ..ended_early(r.exit.code, &r.stderr_text(), &peer.address) })
            }
        })
    }
    fn terminal_argv(&self, peer: &PeerRow, command: &str) -> Option<Vec<String>> {
        Some(ssh::terminal_argv(SSH_BIN, &peer.address, command))
    }
    fn let_in(&self, peer: PeerRow, password: String) -> BoxFuture<'static, Failing<LetInOut>> {
        Box::pin(crate::letin::let_in(self.ctx.clone(), peer, password))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_split_across_chunks() {
        let mut l = Lines::default();
        assert_eq!(l.push(b"@@wisp step ssh do").len(), 0);
        assert_eq!(l.push(b"ne Linux\r\n@@wisp ready 2.0.0 7\n"), ["@@wisp step ssh done Linux", "@@wisp ready 2.0.0 7"]);
    }

    #[test]
    fn an_early_exit_says_ssh_s_last_line_and_a_hint() {
        let f = ended_early(Some(255), "debug\nme@box: Permission denied (publickey).\n", "me@box");
        assert_eq!(f.message, "me@box: Permission denied (publickey).");
        assert!(f.hint.is_some_and(|h| h.let_in));
        assert_eq!(ended_early(Some(255), "", "box").message, "ssh exited (255).");
    }
}
