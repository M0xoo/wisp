//! Feeding a child's input from its own thread, so a program that stops reading blocks only this
//! thread (v1's Python helper juggled non-blocking writes for the same reason).
//!
//! macOS needs more: its terminal drops typed bytes once 1021 are queued, while a write to the
//! master only blocks at 1022 (XNU's ptcwrite checks `TTYHOG - 2`, ttyinput drops above
//! `I_HIGH_WATER - 3`). A big paste into a busy program lost lines that way. So on macOS a PTY's
//! input is written only into the room its queue has left, measured with FIONREAD on the slave.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Receiver;

use crate::registry::Input;

/// Where a PTY's queue can be measured, and whether its program is still there to drain it.
#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code, reason = "only macOS paces"))]
pub struct Pace {
    pub tty: PathBuf,
    pub exited: Arc<AtomicBool>,
}

pub fn feed(rx: &Receiver<Input>, mut writer: Box<dyn Write + Send>, pace: Option<&Pace>) {
    while let Ok(Input::Bytes(bytes)) = rx.recv() {
        let written = match pace {
            Some(p) => paced(&mut writer, &bytes, p),
            None => writer.write_all(&bytes).and_then(|()| writer.flush()),
        };
        if written.is_err() {
            break; // the program closed its input or exited
        }
    }
    // Eof, or the child is gone (its sender dropped): dropping the writer closes stdin.
}

#[cfg(target_os = "macos")]
fn paced(writer: &mut Box<dyn Write + Send>, bytes: &[u8], pace: &Pace) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt as _;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    // Well under 1021: in canonical mode FIONREAD counts complete lines only, and the line being
    // typed sits on top of them.
    const ROOM: usize = 512;
    const STEP: usize = 256;
    // O_NOCTTY: measuring the terminal must not make it ours. Opened per paste, not kept, so the
    // master still sees EOF when the program exits.
    let slave = std::fs::OpenOptions::new().read(true).custom_flags(wisp_native_sys::O_NOCTTY).open(&pace.tty);
    let mut rest = bytes;
    while !rest.is_empty() {
        let queued = match &slave {
            Ok(tty) => wisp_native_sys::input_queued(tty).unwrap_or(0),
            Err(_) => 0, // can't measure: small steps with a pause are the next best thing
        };
        let room = ROOM.saturating_sub(queued);
        if room == 0 {
            if pace.exited.load(Ordering::SeqCst) {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        let n = room.min(STEP).min(rest.len());
        writer.write_all(&rest[..n])?;
        rest = &rest[n..];
        if slave.is_err() && !rest.is_empty() {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    writer.flush()
}

#[cfg(not(target_os = "macos"))]
fn paced(writer: &mut Box<dyn Write + Send>, bytes: &[u8], _pace: &Pace) -> std::io::Result<()> {
    // Linux and Windows block the writer when the terminal is full; nothing is dropped.
    writer.write_all(bytes).and_then(|()| writer.flush())
}
