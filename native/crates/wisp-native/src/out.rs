//! stdout belongs to one thread. Everyone else sends it events over a bounded channel, so a server
//! that reads slowly makes the PTY readers wait (and the programs block on printing) instead of the
//! helper buffering without limit.

use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::protocol::Event;

const QUEUE: usize = 256;

enum Msg {
    Event(Event),
    Flush(mpsc::Sender<()>),
}

#[derive(Debug, Clone)]
pub struct Out {
    tx: SyncSender<Msg>,
}

impl Out {
    pub fn start() -> io::Result<(Out, JoinHandle<()>)> {
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let handle = thread::Builder::new().name("out".into()).spawn(move || write_all(&rx))?;
        Ok((Out { tx }, handle))
    }

    /// Queue an event. A writer that has stopped (stdout closed) drops it: nobody is listening.
    pub fn send(&self, event: Event) {
        let _ = self.tx.send(Msg::Event(event));
    }

    /// Wait (at most `limit`) until everything queued so far has been written.
    pub fn flush(&self, limit: Duration) {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Msg::Flush(tx)).is_ok() {
            match rx.recv_timeout(limit) {
                Ok(()) | Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
            }
        }
    }
}

fn write_all(rx: &Receiver<Msg>) {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut broken = false;
    let mut line = Vec::with_capacity(1024);
    while let Ok(mut msg) = rx.recv() {
        // Write what is queued, then flush once: a burst of output costs one syscall, not one per line.
        loop {
            match msg {
                Msg::Event(event) if !broken => {
                    line.clear();
                    if serde_json::to_writer(&mut line, &event).is_ok() {
                        line.push(b'\n');
                        broken = stdout.write_all(&line).is_err();
                    }
                }
                Msg::Event(_) => {}
                Msg::Flush(done) => {
                    broken = broken || stdout.flush().is_err();
                    let _ = done.send(());
                }
            }
            match rx.try_recv() {
                Ok(next) => msg = next,
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        if !broken && stdout.flush().is_err() {
            // The server is gone; its end of stdin closes too, and the main loop shuts down.
            tracing::warn!("stdout closed");
            broken = true;
        }
    }
}
