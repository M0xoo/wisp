//! A child on pipes, on tokio: one task per output stream, one feeding its input (a child that stops
//! reading blocks only that task), one waiting for its exit. The child leads its own process group
//! (Windows: its own Job Object), so a kill reaches everything it starts.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use crate::BoxFuture;

use crate::child::{ChildControl, ChildHandle};
use crate::resolve::Resolved;
use crate::tree::{self, Tree};
use crate::{
    Child, Exit, KillReport, Output, ProcError, PtySize, Result, Signal, SpawnOpts, Stream, sys,
};

const CHUNK: usize = 64 * 1024;
/// After the child exits, how long its output gets to drain. A background process still holding the
/// pipe would otherwise hold the exit (and `exec`) back for ever.
pub(crate) const DRAIN: Duration = Duration::from_millis(300);

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
    cmd.stdin(if opts.no_stdin {
        Stdio::null()
    } else {
        Stdio::piped()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(false);
    own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| ProcError::from_spawn(bin, &e))?;
    let pid = child.id().ok_or_else(|| ProcError::spawn(bin, "no pid"))?;
    let tree = Tree::new(pid);
    let (out_tx, out_rx) = crate::output_channel();
    let mut readers = Vec::with_capacity(2);
    if let Some(s) = child.stdout.take() {
        readers.push(tokio::spawn(pump(s, Stream::Stdout, out_tx.clone())));
    }
    if let Some(s) = child.stderr.take() {
        readers.push(tokio::spawn(pump(s, Stream::Stderr, out_tx)));
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
        drain(readers).await;
        tracing::debug!(pid, code = ?exit.code, signal = ?exit.signal, "exit");
        let _ = exit_tx.send(Some(exit));
    });
    let control = PipeControl {
        input: Mutex::new(input),
        tree,
        alive,
    };
    let handle = ChildHandle::new(
        pid,
        false,
        opts.grace.unwrap_or(crate::KILL_GRACE),
        Arc::new(control),
        exit_rx,
    );
    Ok(Child {
        handle,
        output: out_rx,
    })
}

/// Output first, then the exit: the last lines arrive before `exited` resolves. Readers still held
/// open after `DRAIN` (a background grandchild) are cut off, which closes the output channel.
async fn drain(readers: Vec<JoinHandle<()>>) {
    let aborts: Vec<_> = readers.iter().map(JoinHandle::abort_handle).collect();
    if tokio::time::timeout(DRAIN, futures_join(readers))
        .await
        .is_err()
    {
        for a in aborts {
            a.abort();
        }
    }
}

async fn futures_join(readers: Vec<JoinHandle<()>>) {
    for r in readers {
        let _ = r.await;
    }
}

async fn pump(mut s: impl AsyncRead + Unpin, stream: Stream, tx: mpsc::Sender<Output>) {
    let mut buf = vec![0u8; CHUNK];
    let mut listening = true;
    loop {
        match s.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            // Nobody reads any more: keep draining so the child never blocks on a full pipe.
            Ok(n) if listening => {
                listening = tx
                    .send(Output {
                        stream,
                        data: buf[..n].to_vec(),
                    })
                    .await
                    .is_ok();
            }
            Ok(_) => {}
        }
    }
}

async fn feed(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(bytes) = rx.recv().await {
        if stdin
            .write_all(&bytes)
            .await
            .and(stdin.flush().await)
            .is_err()
        {
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
            return Exit {
                code: None,
                signal: Some(sys::signal_name(sig)),
            };
        }
    }
    Exit {
        code: status.code(),
        signal: None,
    }
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
pub(crate) fn kill_tree(
    tree: Tree,
    alive: bool,
    sig: Signal,
    grace: Duration,
) -> BoxFuture<'static, KillReport> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || tree::kill(&tree, alive, sig_number(sig), grace))
            .await
            .unwrap_or_default()
    })
}

struct PipeControl {
    input: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    tree: Tree,
    alive: Arc<AtomicBool>,
}

impl ChildControl for PipeControl {
    fn write(&self, data: Vec<u8>) -> Result<()> {
        let guard = self.input.lock().unwrap_or_else(PoisonError::into_inner);
        guard
            .as_ref()
            .ok_or(ProcError::StdinClosed)?
            .send(data)
            .map_err(|_| ProcError::Exited)
    }
    fn close_stdin(&self) {
        self.input
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
    fn resize(&self, _size: PtySize) -> Result<()> {
        Err(ProcError::Unsupported("resize without a pty"))
    }
    fn signal(&self, sig: Signal, whole: bool) -> Result<()> {
        signal_tree(&self.tree, &self.alive, sig, whole)
    }
    fn kill(&self, sig: Signal, grace: Duration) -> BoxFuture<'static, KillReport> {
        kill_tree(
            self.tree.clone(),
            self.alive.load(Ordering::SeqCst),
            sig,
            grace,
        )
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
