//! A child on a pseudo-terminal (portable-pty), replacing v1's Python `pty.fork` helper and its
//! `script(1)` fallback. portable-pty is blocking, so each terminal has three small threads: one reads
//! the terminal into the output channel, one writes typed input (a program that stops reading blocks
//! only that thread: a big paste never hangs the printer), one waits for the exit.
//!
//! The child is a session leader (setsid), so its pid is its process group and a tree kill reaches
//! everything it started; on Windows it goes into a Job Object like a piped child.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use portable_pty::{CommandBuilder, MasterPty, PtySize as Size};
use tokio::sync::{mpsc, watch};
use crate::BoxFuture;

use crate::child::{ChildControl, ChildHandle};
use crate::pipes::{DRAIN, kill_tree, signal_tree};
use crate::resolve::Resolved;
use crate::tree::Tree;
use crate::{
    Child, Exit, KillReport, Output, ProcError, PtySize, Result, Signal, SpawnOpts, Stream,
};

const CHUNK: usize = 64 * 1024;
/// ^D: a terminal's end of input.
const EOT: u8 = 0x04;

/// The output sender, shared so the wait thread can close the channel after the drain even while a
/// background process keeps the terminal open (and the reader blocked in `read`).
type Slot = Arc<Mutex<Option<mpsc::Sender<Output>>>>;

pub(crate) fn spawn(bin: &str, r: &Resolved, opts: &SpawnOpts, size: PtySize) -> Result<Child> {
    // The size goes on when the PTY is made, before the program starts: v1 learned that a size set
    // afterwards races the program's first look (`stty size` said 0 0 on a busy machine).
    let size = Size {
        rows: size.rows.max(1),
        cols: size.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = portable_pty::native_pty_system()
        .openpty(size)
        .map_err(|e| ProcError::spawn(bin, e))?;
    let child = pair
        .slave
        .spawn_command(command(r, opts))
        .map_err(|e| ProcError::spawn(bin, e))?;
    // Our copy of the slave side would keep the terminal open after the program exits.
    drop(pair.slave);
    let pid = child
        .process_id()
        .ok_or_else(|| ProcError::spawn(bin, "no pid"))?;
    let tree = Tree::new(pid);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| ProcError::spawn(bin, e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| ProcError::spawn(bin, e))?;
    let (out_tx, out_rx) = crate::output_channel();
    let slot: Slot = Arc::new(Mutex::new(Some(out_tx)));
    let (done_tx, done_rx) = std_mpsc::channel();
    let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
    let alive = Arc::new(AtomicBool::new(true));
    let (exit_tx, exit_rx) = watch::channel(None);
    let name = format!("pty-{pid}");
    let reader_slot = slot.clone();
    thread::Builder::new()
        .name(format!("{name}-read"))
        .spawn(move || read(reader, &reader_slot, &done_tx))?;
    thread::Builder::new()
        .name(format!("{name}-write"))
        .spawn(move || feed(&in_rx, writer))?;
    let alive2 = alive.clone();
    thread::Builder::new()
        .name(format!("{name}-wait"))
        .spawn(move || {
            let exit = wait(child);
            alive2.store(false, Ordering::SeqCst);
            // Output first, then the exit: the last screen includes the final lines.
            let _ = done_rx.recv_timeout(DRAIN);
            slot.lock().unwrap_or_else(PoisonError::into_inner).take();
            tracing::debug!(pid, code = ?exit.code, signal = ?exit.signal, "pty exit");
            let _ = exit_tx.send(Some(exit));
        })?;
    let control = PtyControl {
        input: Mutex::new(Some(in_tx)),
        master: Mutex::new(pair.master),
        tree,
        alive,
    };
    let handle = ChildHandle::new(
        pid,
        true,
        opts.grace.unwrap_or(crate::KILL_GRACE),
        Arc::new(control),
        exit_rx,
    );
    Ok(Child {
        handle,
        output: out_rx,
    })
}

fn command(r: &Resolved, opts: &SpawnOpts) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&r.command);
    cmd.args(&r.args);
    // portable-pty starts in $HOME without one; a piped child starts where wisp is: keep them alike.
    let cwd = opts
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"));
    cmd.cwd(cwd);
    if opts.env.clear {
        cmd.env_clear();
    }
    for k in &opts.env.remove {
        cmd.env_remove(k);
    }
    for (k, v) in &opts.env.set {
        cmd.env(k, v);
    }
    cmd
}

fn read(mut reader: Box<dyn Read + Send>, slot: &Slot, done: &std_mpsc::Sender<()>) {
    let mut buf = vec![0u8; CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                // Cloned out of the lock: a full channel blocks this thread, never the wait thread.
                let tx = slot.lock().unwrap_or_else(PoisonError::into_inner).clone();
                match tx {
                    Some(tx) => {
                        let _ = tx.blocking_send(Output {
                            stream: Stream::Stdout,
                            data: buf[..n].to_vec(),
                        });
                    }
                    None => break, // the exit was announced: it is the last word
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            // EIO is how Linux reports a terminal whose program has gone.
            Err(_) => break,
        }
    }
    let _ = done.send(());
}

fn feed(rx: &std_mpsc::Receiver<Vec<u8>>, mut writer: Box<dyn Write + Send>) {
    while let Ok(bytes) = rx.recv() {
        if writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

/// portable-pty reports a signal as strsignal(3) text; the std status underneath has the number.
fn wait(child: Box<dyn portable_pty::Child + Send + Sync>) -> Exit {
    let child: Box<dyn portable_pty::Child> = child;
    match child.downcast::<std::process::Child>() {
        Ok(mut c) => c.wait().map(crate::pipes::exit_of).unwrap_or_default(),
        Err(mut other) => other
            .wait()
            .map(|s| Exit {
                code: i32::try_from(s.exit_code()).ok(),
                signal: None,
            })
            .unwrap_or_default(),
    }
}

struct PtyControl {
    input: Mutex<Option<std_mpsc::Sender<Vec<u8>>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    tree: Tree,
    alive: Arc<AtomicBool>,
}

impl ChildControl for PtyControl {
    fn write(&self, data: Vec<u8>) -> Result<()> {
        let guard = self.input.lock().unwrap_or_else(PoisonError::into_inner);
        guard
            .as_ref()
            .ok_or(ProcError::StdinClosed)?
            .send(data)
            .map_err(|_| ProcError::Exited)
    }
    fn close_stdin(&self) {
        let _ = self.write(vec![EOT]);
    }
    fn resize(&self, size: PtySize) -> Result<()> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(ProcError::Exited);
        }
        let size = Size {
            rows: size.rows.max(1),
            cols: size.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        self.master
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .resize(size)
            .map_err(|e| ProcError::Io(io::Error::other(e.to_string())))
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
