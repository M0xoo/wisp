//! A child on pipes, on tokio: one task per output stream, one feeding its input (a child that stops
//! reading blocks only that task), one waiting for its exit. The child leads its own process group
//! (Windows: its own Job Object), so a kill reaches everything it starts.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use crate::BoxFuture;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::child::{ChildControl, ChildHandle};
use crate::resolve::Resolved;
use crate::tree::{self, Tree};
use crate::{Child, Exit, KillReport, Output, ProcError, PtySize, Result, Signal, SpawnOpts, Stream, sys};

const CHUNK: usize = 64 * 1024;
/// After the child exits, how long a read of its output may wait with nothing coming before the reader
/// stops: a background process still holding the pipe would otherwise hold the exit (and `exec`) back for
/// ever. It's an idle limit per read, not a deadline from the exit: output already in the pipe is always
/// read, however late a busy runtime gets to the reader (`tokio::time::timeout` polls the read first).
pub(crate) const DRAIN: Duration = Duration::from_millis(300);
/// …and the most it reads after the exit at all (a background process that keeps writing).
pub(crate) const DRAIN_MAX: Duration = Duration::from_secs(5);

pub(crate) fn spawn(bin: &str, r: &Resolved, opts: &SpawnOpts) -> Result<Child> {
    let mut cmd = tokio::process::Command::new(&r.command);
    add_args(&mut cmd, r);
    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    if opts.env.clear {
        cmd.env_clear();
    }
    for k in &opts.env.remove {
        cmd.env_remove(k);
    }
    cmd.envs(opts.env.set.iter().map(|(k, v)| (k, v)));
    cmd.stdin(if opts.no_stdin { Stdio::null() } else { Stdio::piped() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(false);
    own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| ProcError::from_spawn(bin, &e))?;
    let pid = child.id().ok_or_else(|| ProcError::spawn(bin, "no pid"))?;
    let tree = Tree::new(pid);
    let (out_tx, out_rx) = crate::output_channel();
    let (gone_tx, gone_rx) = watch::channel(false);
    let mut readers = Vec::with_capacity(2);
    if let Some(s) = child.stdout.take() {
        readers.push(tokio::spawn(pump(s, Stream::Stdout, out_tx.clone(), gone_rx.clone())));
    }
    if let Some(s) = child.stderr.take() {
        readers.push(tokio::spawn(pump(s, Stream::Stderr, out_tx, gone_rx)));
    }
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let input = child.stdin.take().map(|stdin| {
        tokio::spawn(feed(stdin, in_rx));
        in_tx
    });
    let alive = Arc::new(AtomicBool::new(true));
    let (exit_tx, exit_rx) = watch::channel(None);
    let alive2 = alive.clone();
    tokio::spawn(async move {
        let exit = child.wait().await.map(exit_of).unwrap_or_default();
        // Reaped: its pid may be a stranger's from now on, only its group is ours.
        alive2.store(false, Ordering::SeqCst);
        let _ = gone_tx.send(true);
        drain(readers).await;
        tracing::debug!(pid, code = ?exit.code, signal = ?exit.signal, "exit");
        let _ = exit_tx.send(Some(exit));
    });
    let control = PipeControl { input: Mutex::new(input), tree, alive };
    let handle = ChildHandle::new(pid, false, opts.grace.unwrap_or(crate::KILL_GRACE), Arc::new(control), exit_rx);
    Ok(Child { handle, output: out_rx })
}

/// Output first, then the exit: the last lines arrive before `exited` resolves. Each reader stops at the
/// end of its stream, or (the child gone) once a read has waited `DRAIN` with nothing coming.
async fn drain(readers: Vec<JoinHandle<()>>) {
    for r in readers {
        let _ = r.await;
    }
}

/// One read, the child gone or not: while it runs, as long as it takes; once it's gone, `DRAIN` idle at
/// most (None: stop reading).
async fn read_some(s: &mut (impl AsyncRead + Unpin), buf: &mut [u8], gone: &mut watch::Receiver<bool>) -> Option<std::io::Result<usize>> {
    loop {
        if *gone.borrow() {
            return tokio::time::timeout(DRAIN, s.read(buf)).await.ok();
        }
        tokio::select! {
            biased;
            r = s.read(buf) => return Some(r),
            c = gone.changed() => {
                if c.is_err() {
                    return tokio::time::timeout(DRAIN, s.read(buf)).await.ok();
                }
            }
        }
    }
}

pub(crate) async fn pump(mut s: impl AsyncRead + Unpin, stream: Stream, tx: mpsc::Sender<Output>, mut gone: watch::Receiver<bool>) {
    let mut buf = vec![0u8; CHUNK];
    let mut listening = true;
    let mut gone_at: Option<tokio::time::Instant> = None;
    loop {
        if *gone.borrow() {
            let at = *gone_at.get_or_insert_with(tokio::time::Instant::now);
            if at.elapsed() > DRAIN_MAX {
                break;
            }
        }
        match read_some(&mut s, &mut buf, &mut gone).await {
            None | Some(Ok(0) | Err(_)) => break,
            // Nobody reads any more: keep draining so the child never blocks on a full pipe.
            Some(Ok(n)) if listening => {
                listening = tx.send(Output { stream, data: buf[..n].to_vec() }).await.is_ok();
            }
            Some(Ok(_)) => {}
        }
    }
}

async fn feed(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(bytes) = rx.recv().await {
        if stdin.write_all(&bytes).await.and(stdin.flush().await).is_err() {
            break; // it closed its input or exited
        }
    }
    // closed (the sender was dropped): dropping stdin closes the pipe
}

pub(crate) fn exit_of(status: std::process::ExitStatus) -> Exit {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if let Some(sig) = status.signal() {
            return Exit { code: None, signal: Some(sys::signal_name(sig)) };
        }
    }
    Exit { code: status.code(), signal: None }
}

#[cfg(unix)]
fn add_args(cmd: &mut tokio::process::Command, r: &Resolved) {
    cmd.args(&r.args);
}

#[cfg(windows)]
fn add_args(cmd: &mut tokio::process::Command, r: &Resolved) {
    if r.verbatim {
        for a in &r.args {
            cmd.raw_arg(a);
        }
    } else {
        cmd.args(&r.args);
    }
}

/// The child leads a new process group, so killpg reaches everything it starts.
#[cfg(unix)]
fn own_group(cmd: &mut tokio::process::Command) {
    cmd.process_group(0);
}

/// No console window for a piped child (v1's `windowsHide`).
#[cfg(windows)]
fn own_group(cmd: &mut tokio::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub(crate) fn sig_number(sig: Signal) -> i32 {
    match sig {
        Signal::Term => sys::SIGTERM,
        Signal::Kill => sys::SIGKILL,
        Signal::Int => sys::SIGINT,
        Signal::Hup => sys::SIGHUP,
    }
}

/// `tree::kill` polls with sleeps: off the runtime's workers.
pub(crate) fn kill_tree(tree: Tree, alive: bool, sig: Signal, grace: Duration) -> BoxFuture<'static, KillReport> {
    Box::pin(async move { tokio::task::spawn_blocking(move || tree::kill(&tree, alive, sig_number(sig), grace)).await.unwrap_or_default() })
}

struct PipeControl {
    input: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    tree: Tree,
    alive: Arc<AtomicBool>,
}

impl ChildControl for PipeControl {
    fn write(&self, data: Vec<u8>) -> Result<()> {
        let guard = self.input.lock().unwrap_or_else(PoisonError::into_inner);
        guard.as_ref().ok_or(ProcError::StdinClosed)?.send(data).map_err(|_| ProcError::Exited)
    }
    fn close_stdin(&self) {
        self.input.lock().unwrap_or_else(PoisonError::into_inner).take();
    }
    fn resize(&self, _size: PtySize) -> Result<()> {
        Err(ProcError::Unsupported("resize without a pty"))
    }
    fn signal(&self, sig: Signal, whole: bool) -> Result<()> {
        signal_tree(&self.tree, &self.alive, sig, whole)
    }
    fn kill(&self, sig: Signal, grace: Duration) -> BoxFuture<'static, KillReport> {
        kill_tree(self.tree.clone(), self.alive.load(Ordering::SeqCst), sig, grace)
    }
}

/// A reaped root's pid may be a stranger's: only the group (the tree) is still ours to signal.
pub(crate) fn signal_tree(tree: &Tree, alive: &AtomicBool, sig: Signal, whole: bool) -> Result<()> {
    let alive = alive.load(Ordering::SeqCst);
    if !whole && !alive {
        return Err(ProcError::Exited);
    }
    tree::signal(tree, alive, sig_number(sig), whole).map_err(ProcError::Io)
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used, reason = "a test")]
mod tests {
    use super::*;

    /// What the child wrote before it exited is read even when the reader first runs long after the
    /// exit, and with a background process still holding the pipe open the reader then stops by itself.
    #[tokio::test(flavor = "current_thread")]
    async fn output_already_written_survives_a_late_reader() {
        let (mut w, r) = tokio::net::unix::pipe::pipe().unwrap();
        w.write_all(b"serverInfo\n").await.unwrap();
        let (tx, mut rx) = crate::output_channel();
        let (gone_tx, gone_rx) = watch::channel(false);
        let _ = gone_tx.send(true);
        // a busy runtime: nothing runs for longer than DRAIN after the exit
        std::thread::sleep(DRAIN * 3);
        let start = tokio::time::Instant::now();
        pump(r, Stream::Stdout, tx, gone_rx).await;
        assert!(start.elapsed() < DRAIN * 3, "the held pipe didn't hold the reader: {:?}", start.elapsed());
        assert_eq!(rx.recv().await.map(|o| o.data), Some(b"serverInfo\n".to_vec()));
        drop(w);
    }
}
