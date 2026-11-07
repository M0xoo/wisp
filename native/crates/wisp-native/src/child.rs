//! Starting a child, on a PTY or on pipes, and the threads that serve it: one per output stream,
//! one feeding its input (input.rs), one waiting for its exit.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::{CommandBuilder, PtySize};
use wisp_native_sys as sys;

use crate::error::{Error, Result};
use crate::input::{self, Pace};
use crate::out::Out;
use crate::protocol::{Event, Spawn, Stream};
use crate::registry::{self, Entry, Input, Shared};
use crate::tree::Tree;

const CHUNK: usize = 64 * 1024;
/// After the child exits, how long its output gets to drain. A background process still holding
/// the terminal would otherwise hold the exit back for ever.
const DRAIN: Duration = Duration::from_millis(300);

struct Exit {
    code: Option<i32>,
    signal: Option<String>,
}

impl From<std::process::ExitStatus> for Exit {
    fn from(status: std::process::ExitStatus) -> Exit {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt as _;
            if let Some(sig) = status.signal() {
                return Exit { code: None, signal: Some(sys::signal_name(sig)) };
            }
        }
        Exit { code: status.code(), signal: None }
    }
}

type Waiter = Box<dyn FnOnce() -> io::Result<Exit> + Send>;

/// Start `req`, register it, announce `started`, then start its threads (in that order, so
/// `started` is always the first event for the id).
pub fn spawn(req: Spawn, reg: &Shared, out: &Out) -> Result<u32> {
    registry::lock(reg).check_free(&req.id)?;
    if let Some(cwd) = &req.cwd {
        // portable-pty would quietly fall back to $HOME; a wrong folder must fail instead.
        if !Path::new(cwd).is_dir() {
            return Err(Error::spawn(&req.cmd, format!("no such folder: {cwd}")));
        }
    }
    let started = if req.pty.is_some() { start_pty(&req)? } else { start_pipes(&req)? };
    let id = req.id;
    let pid = started.entry.pid;
    registry::lock(reg).insert(id.clone(), started.entry);
    out.send(Event::Started { id: id.clone(), pid });
    let exited = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = mpsc::channel();
    let streams = started.readers.len();
    for (stream, reader) in started.readers {
        let ctx = Pump { id: id.clone(), stream, out: out.clone(), exited: Arc::clone(&exited), done: done_tx.clone() };
        thread::Builder::new().name(format!("read-{id}")).spawn(move || ctx.run(reader))?;
    }
    let (rx, writer) = (started.input_rx, started.writer);
    let pace = started.tty.map(|tty| Pace { tty, exited: Arc::clone(&exited) });
    thread::Builder::new().name(format!("write-{id}")).spawn(move || input::feed(&rx, writer, pace.as_ref()))?;
    let (reg, out) = (Arc::clone(reg), out.clone());
    thread::Builder::new().name(format!("wait-{id}")).spawn(move || {
        let exit = (started.wait)().unwrap_or(Exit { code: None, signal: None });
        // Output first, then the exit: the server's last screen must include the final lines.
        let end = Instant::now() + DRAIN;
        for _ in 0..streams {
            if done_rx.recv_timeout(end.saturating_duration_since(Instant::now())).is_err() {
                break;
            }
        }
        exited.store(true, Ordering::SeqCst);
        registry::lock(&reg).exited(&id);
        tracing::info!(id, code = ?exit.code, signal = ?exit.signal, "exit");
        out.send(Event::Exit { id, code: exit.code, signal: exit.signal });
    })?;
    Ok(pid)
}

struct Started {
    entry: Entry,
    readers: Vec<(Stream, Box<dyn Read + Send>)>,
    writer: Box<dyn Write + Send>,
    input_rx: Receiver<Input>,
    /// The PTY's slave path, where macOS input pacing measures the queue.
    tty: Option<PathBuf>,
    wait: Waiter,
}

fn start_pty(req: &Spawn) -> Result<Started> {
    let size = req.pty.map_or(PtySize::default(), |s| PtySize { rows: s.rows.max(1), cols: s.cols.max(1), ..PtySize::default() });
    // The size is set when the PTY is made, before the program starts: v1 learned that a size set
    // afterwards races the program's first look (stty size said 0 0).
    let pair = portable_pty::native_pty_system().openpty(size).map_err(|e| Error::spawn(&req.cmd, e))?;
    let mut cmd = CommandBuilder::new(&req.cmd);
    cmd.args(&req.args);
    if let Some(cwd) = &req.cwd {
        cmd.cwd(cwd);
    }
    if let Some(env) = &req.env {
        cmd.env_clear();
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| Error::spawn(&req.cmd, e))?;
    // Our copy of the terminal's slave side would keep it open after the program exits.
    drop(pair.slave);
    let pid = child.process_id().ok_or_else(|| Error::spawn(&req.cmd, "no pid"))?;
    let reader = pair.master.try_clone_reader().map_err(|e| Error::spawn(&req.cmd, e))?;
    let writer = pair.master.take_writer().map_err(|e| Error::spawn(&req.cmd, e))?;
    let (input_tx, input_rx) = mpsc::channel();
    let tree = make_tree(pid);
    let tty = pacing_tty(pair.master.as_ref());
    Ok(Started {
        entry: Entry { pid, tree, input: Some(input_tx), master: Some(pair.master) },
        readers: vec![(Stream::Stdout, reader)],
        writer,
        input_rx,
        tty,
        wait: Box::new(move || wait_pty(child)),
    })
}

#[cfg(target_os = "macos")]
fn pacing_tty(master: &dyn portable_pty::MasterPty) -> Option<PathBuf> {
    master.tty_name()
}

/// Only macOS drops input (input.rs); elsewhere the writer simply blocks.
#[cfg(not(target_os = "macos"))]
fn pacing_tty(_master: &dyn portable_pty::MasterPty) -> Option<PathBuf> {
    None
}

/// portable-pty reports a signal as strsignal(3) text; the std status underneath has the number.
fn wait_pty(child: Box<dyn portable_pty::Child + Send + Sync>) -> io::Result<Exit> {
    let child: Box<dyn portable_pty::Child> = child;
    match child.downcast::<std::process::Child>() {
        Ok(mut std_child) => std_child.wait().map(Exit::from),
        Err(mut other) => other.wait().map(|s| Exit { code: i32::try_from(s.exit_code()).ok(), signal: None }),
    }
}

fn start_pipes(req: &Spawn) -> Result<Started> {
    let mut cmd = Command::new(&req.cmd);
    add_args(&mut cmd, req);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = &req.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &req.env {
        cmd.env_clear().envs(env);
    }
    own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::spawn(&req.cmd, e))?;
    let pid = child.id();
    let tree = make_tree(pid);
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        return Err(Error::spawn(&req.cmd, "missing pipe"));
    };
    let (stdin, stdout, stderr): (Box<dyn Write + Send>, Box<dyn Read + Send>, Box<dyn Read + Send>) =
        (Box::new(stdin), Box::new(stdout), Box::new(stderr));
    let (input_tx, input_rx) = mpsc::channel();
    Ok(Started {
        entry: Entry { pid, tree, input: Some(input_tx), master: None },
        readers: vec![(Stream::Stdout, stdout), (Stream::Stderr, stderr)],
        writer: stdin,
        input_rx,
        tty: None,
        wait: Box::new(move || child.wait().map(Exit::from)),
    })
}

#[cfg(unix)]
fn add_args(cmd: &mut Command, req: &Spawn) {
    cmd.args(&req.args);
}

#[cfg(windows)]
fn add_args(cmd: &mut Command, req: &Spawn) {
    use std::os::windows::process::CommandExt as _;
    if req.verbatim {
        for a in &req.args {
            cmd.raw_arg(a);
        }
    } else {
        cmd.args(&req.args);
    }
}

/// The child leads a new process group, so killpg reaches everything it starts.
#[cfg(unix)]
fn own_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt as _;
    cmd.process_group(0);
}

/// No console window for a piped child (v1's `windowsHide`).
#[cfg(windows)]
fn own_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn make_tree(pid: u32) -> Tree {
    Tree { root: pid }
}

#[cfg(windows)]
fn make_tree(pid: u32) -> Tree {
    // A child that can't be put in a job is still killed, by walking its descendants.
    let job = sys::Job::new().and_then(|job| job.assign(pid).map(|()| Arc::new(job)));
    if let Err(e) = &job {
        tracing::warn!(pid, error = %e, "no job object");
    }
    Tree { root: pid, job: job.ok() }
}

struct Pump {
    id: String,
    stream: Stream,
    out: Out,
    exited: Arc<AtomicBool>,
    done: Sender<()>,
}

impl Pump {
    fn run(self, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if self.exited.load(Ordering::SeqCst) {
                        break; // `exit` was sent: it is the last event for this id
                    }
                    let data = B64.encode(&buf[..n]);
                    self.out.send(Event::Data { id: self.id.clone(), stream: self.stream, data });
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                // EIO is how Linux reports a PTY whose program has gone.
                Err(_) => break,
            }
        }
        let _ = self.done.send(());
    }
}
