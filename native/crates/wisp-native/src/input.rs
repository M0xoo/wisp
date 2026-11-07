//! Feeding a child's input from its own thread, so a program that stops reading blocks only this
//! thread (v1's Python helper juggled non-blocking writes for the same reason).

use std::io::Write;
use std::sync::mpsc::Receiver;

use crate::registry::Input;

pub fn feed(rx: &Receiver<Input>, mut writer: Box<dyn Write + Send>) {
    while let Ok(Input::Bytes(bytes)) = rx.recv() {
        if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
            break; // the program closed its input or exited
        }
    }
    // Eof, or the child is gone (its sender dropped): dropping the writer closes stdin.
}
