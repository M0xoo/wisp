//! A simulated proc service for tests (plan §6.1: "tests replace `clock` and `proc` with simulated
//! ones"). Programs are async closures registered by name; a spawn runs one with its input, output and
//! kill signal as channels, so plugin tests need no real process, PTY or language server.
//!
//! ```ignore
//! let sim = SimProc::new().program("gopls", |mut io| async move {
//!     while let Some(bytes) = io.stdin.recv().await { io.print(&bytes).await; }
//!     Exit { code: Some(0), signal: None }
//! });
//! let proc: Proc = Arc::new(sim.clone());
//! ```

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::BoxFuture;

use crate::child::{ChildControl, ChildHandle, tie_to_scope};
use crate::{
    Child, ExecOpts, ExecResult, Exit, KillReport, Output, ProcError, ProcService, PtySize, Result,
    Signal, SpawnOpts, Stream,
};

type Program = Arc<dyn Fn(SimIo) -> BoxFuture<'static, Exit> + Send + Sync>;

/// What a simulated program sees.
#[derive(Debug)]
pub struct SimIo {
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// the env patch it was given (resolved against an empty parent)
    pub env: Vec<(String, String)>,
    pub pty: Option<PtySize>,
    /// its input; `None` once stdin is closed
    pub stdin: mpsc::UnboundedReceiver<Vec<u8>>,
    pub out: mpsc::Sender<Output>,
    /// the latest size a resize asked for
    pub size: watch::Receiver<Option<PtySize>>,
    /// signals sent to it, in order (`kill` sends its signal here before ending it)
    pub signals: mpsc::UnboundedReceiver<Signal>,
    /// cancelled when it is killed: a program that ignores it is ended anyway
    pub killed: CancellationToken,
}

impl SimIo {
    pub async fn print(&self, bytes: &[u8]) {
        let _ = self
            .out
            .send(Output {
                stream: Stream::Stdout,
                data: bytes.to_vec(),
            })
            .await;
    }
    pub async fn eprint(&self, bytes: &[u8]) {
        let _ = self
            .out
            .send(Output {
                stream: Stream::Stderr,
                data: bytes.to_vec(),
            })
            .await;
    }
}

/// One spawn, as the test sees it afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawned {
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub pty: Option<PtySize>,
    pub detached: bool,
}

#[derive(Default)]
struct State {
    programs: HashMap<String, Program>,
    spawned: Vec<Spawned>,
}

/// The simulated service. Clones share programs and records.
#[derive(Clone, Default)]
pub struct SimProc {
    state: Arc<Mutex<State>>,
    live: Arc<AtomicUsize>,
    next_pid: Arc<AtomicU32>,
}

impl fmt::Debug for SimProc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SimProc")
            .field("live", &self.live.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl SimProc {
    pub fn new() -> Self {
        Self {
            next_pid: Arc::new(AtomicU32::new(1000)),
            ..Self::default()
        }
    }

    /// Registers `name` (as found by `which` and run by `spawn`/`exec`).
    #[must_use]
    pub fn program<F, Fut>(self, name: &str, f: F) -> Self
    where
        F: Fn(SimIo) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Exit> + Send + 'static,
    {
        let program: Program = Arc::new(move |io| Box::pin(f(io)));
        self.lock().programs.insert(name.to_owned(), program);
        self
    }

    /// A program that prints `out` and exits with `code`.
    #[must_use]
    pub fn prints(self, name: &str, out: &str, code: i32) -> Self {
        let out = out.to_owned();
        self.program(name, move |io| {
            let out = out.clone();
            async move {
                io.print(out.as_bytes()).await;
                Exit {
                    code: Some(code),
                    signal: None,
                }
            }
        })
    }

    /// Every spawn so far, in order.
    pub fn spawned(&self) -> Vec<Spawned> {
        self.lock().spawned.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn record(
        &self,
        bin: &str,
        args: &[String],
        opts: &SpawnOpts,
        detached: bool,
    ) -> Option<Program> {
        let mut st = self.lock();
        st.spawned.push(Spawned {
            bin: bin.to_owned(),
            args: args.to_vec(),
            cwd: opts.cwd.clone(),
            env: opts.env.resolve(Vec::new()),
            pty: opts.pty,
            detached,
        });
        st.programs.get(base_name(bin)).cloned()
    }
}

fn base_name(bin: &str) -> &str {
    bin.rsplit(['/', '\\']).next().unwrap_or(bin)
}

struct SimControl {
    stdin: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    size: watch::Sender<Option<PtySize>>,
    signals: mpsc::UnboundedSender<Signal>,
    killed: CancellationToken,
    exit: watch::Receiver<Option<Exit>>,
}

impl ChildControl for SimControl {
    fn write(&self, data: Vec<u8>) -> Result<()> {
        let guard = self.stdin.lock().unwrap_or_else(PoisonError::into_inner);
        let tx = guard.as_ref().ok_or(ProcError::StdinClosed)?;
        tx.send(data).map_err(|_| ProcError::Exited)
    }
    fn close_stdin(&self) {
        self.stdin
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
    fn resize(&self, size: PtySize) -> Result<()> {
        self.size.send_replace(Some(size));
        Ok(())
    }
    fn signal(&self, sig: Signal, _tree: bool) -> Result<()> {
        self.signals.send(sig).map_err(|_| ProcError::Exited)
    }
    fn kill(&self, sig: Signal, grace: Duration) -> BoxFuture<'static, KillReport> {
        let _ = self.signals.send(sig);
        let (killed, mut exit) = (self.killed.clone(), self.exit.clone());
        Box::pin(async move {
            if exit.borrow().is_some() {
                return KillReport::default();
            }
            // The program may end on its signal within the grace; otherwise it is cut off.
            let _ = tokio::time::timeout(grace, exit.wait_for(Option::is_some)).await;
            killed.cancel();
            let _ = exit.wait_for(Option::is_some).await;
            KillReport {
                signalled: 1,
                survivors: 0,
            }
        })
    }
}

impl ProcService for SimProc {
    fn which(
        &self,
        bin: &str,
        _env: Option<Vec<(String, String)>>,
    ) -> BoxFuture<'static, Option<PathBuf>> {
        let found = self
            .lock()
            .programs
            .contains_key(base_name(bin))
            .then(|| PathBuf::from(format!("/sim/bin/{}", base_name(bin))));
        Box::pin(async move { found })
    }

    fn spawn(&self, bin: &str, args: &[String], opts: SpawnOpts) -> Result<Child> {
        let program = self
            .record(bin, args, &opts, false)
            .ok_or_else(|| ProcError::NotFound(bin.to_owned()))?;
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = crate::output_channel();
        let (size_tx, size_rx) = watch::channel(opts.pty);
        let (sig_tx, sig_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(None);
        let killed = CancellationToken::new();
        let io = SimIo {
            bin: bin.to_owned(),
            args: args.to_vec(),
            cwd: opts.cwd.clone(),
            env: opts.env.resolve(Vec::new()),
            pty: opts.pty,
            stdin: stdin_rx,
            out: out_tx,
            size: size_rx,
            signals: sig_rx,
            killed: killed.clone(),
        };
        let control = SimControl {
            stdin: Mutex::new((!opts.no_stdin).then_some(stdin_tx)),
            size: size_tx,
            signals: sig_tx,
            killed: killed.clone(),
            exit: exit_rx.clone(),
        };
        let pid = self.next_pid.fetch_add(1, Ordering::SeqCst);
        let handle = ChildHandle::new(
            pid,
            opts.pty.is_some(),
            opts.grace.unwrap_or(crate::KILL_GRACE),
            Arc::new(control),
            exit_rx,
        );
        let live = self.live.clone();
        live.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let exit = tokio::select! {
                exit = program(io) => exit,
                () = killed.cancelled() => Exit { code: None, signal: Some("SIGKILL".into()) },
            };
            live.fetch_sub(1, Ordering::SeqCst);
            let _ = exit_tx.send(Some(exit));
        });
        tie_to_scope(&handle, opts.scope);
        Ok(Child {
            handle,
            output: out_rx,
        })
    }

    fn exec(
        &self,
        bin: &str,
        args: &[String],
        opts: ExecOpts,
    ) -> BoxFuture<'static, Result<ExecResult>> {
        let spawned = self.spawn(
            bin,
            args,
            SpawnOpts {
                cwd: opts.cwd.clone(),
                env: opts.env.clone(),
                scope: opts.scope.clone(),
                ..SpawnOpts::default()
            },
        );
        Box::pin(async move { crate::local::collect(spawned?, opts).await })
    }

    fn spawn_detached(&self, bin: &str, args: &[String], opts: SpawnOpts) -> Result<u32> {
        self.record(bin, args, &opts, true);
        Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
    }

    fn live(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }

    fn kill_all(&self, _grace: Duration) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}
