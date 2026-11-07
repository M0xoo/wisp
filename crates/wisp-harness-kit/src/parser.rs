//! The shape every harness stream parser has (plan §3.1 rule 3: sans-IO). A parser is a machine fed
//! one stdout line at a time, and the process's exit once; it answers with the events to report, in
//! order. It never reads a file, a clock or a socket: the time comes in as `now_ms`, and where a
//! harness needs the disk (the file as it was before a write) the parser puts an [`IoStep`] in the
//! list, which the driver runs in place, keeping the order. Fixtures can then test a parser byte for
//! byte, and the host's driver is the only IO.

use crate::event::HarnessEvent;

/// How the process ended (v1 spawnJsonl's `onClose` argument).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    /// its last 8000 characters of stderr, trimmed
    pub stderr: String,
    /// killed by `stop()` or a signal
    pub stopped: bool,
    /// killed by `stop()` only (Windows reports a killed child as an ordinary exit code)
    pub stop_requested: bool,
}

impl Exit {
    /// v1's exit for a CLI that finished on its own.
    pub fn clean() -> Self {
        Self {
            code: Some(0),
            ..Self::default()
        }
    }
}

/// A piece of IO a parser needs, run by the driver where it stands in the list. The driver turns each
/// into the events it stands for (with [`crate::tracker`] and [`crate::protocol::write_change`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IoStep {
    /// A Write is about to replace `abs`: read it now (at most `MAX_SNAPSHOT` bytes, else it counts as
    /// a new file) and report a `change` (early) from it to `after`. `file` is the project-relative path.
    WriteBefore {
        abs: String,
        file: String,
        after: String,
    },
    /// The harness announced an edit to `file`: keep what it holds now (the tracker's `remember`).
    Remember { file: String },
    /// The harness wrote `file`: report a `change` if it differs (the tracker's `change`).
    Changed { file: String },
}

/// One item a parser answers with.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Event(HarnessEvent),
    Io(IoStep),
}

impl From<HarnessEvent> for Out {
    fn from(e: HarnessEvent) -> Self {
        Self::Event(e)
    }
}

/// A harness's stream parser.
pub trait LineParser: Send {
    /// One stdout line, without its line end. Stream-json parsers skip blank and non-JSON lines.
    fn line(&mut self, line: &str, now_ms: i64, out: &mut Vec<Out>);
    /// stderr as it comes, for CLIs that only report trouble there.
    fn stderr(&mut self, _text: &str, _now_ms: i64, _out: &mut Vec<Out>) {}
    /// The process ended: the parser emits the final `result` if the stream didn't.
    fn close(&mut self, exit: &Exit, now_ms: i64, out: &mut Vec<Out>);
}

/// What resolves IO steps in a replay: tests pass a fake, the host's driver runs the real thing.
pub trait ReplayIo {
    fn run(&mut self, step: &IoStep, out: &mut Vec<HarnessEvent>);
}

/// IO that finds nothing on disk: every file is missing.
#[derive(Debug, Default)]
pub struct NoDisk;

impl ReplayIo for NoDisk {
    fn run(&mut self, step: &IoStep, out: &mut Vec<HarnessEvent>) {
        if let IoStep::WriteBefore { file, after, .. } = step {
            out.push(crate::protocol::write_change(file, None, after));
        }
    }
}

/// Runs a parser over recorded lines with a given IO: what a golden test and the bench do. `now(i)`
/// is the clock reading for line `i` (the close gets `now(lines.len())`).
pub fn replay<P: LineParser + ?Sized>(
    parser: &mut P,
    lines: &[&str],
    exit: &Exit,
    io: &mut dyn ReplayIo,
    now: impl Fn(usize) -> i64,
) -> Vec<HarnessEvent> {
    let mut events = Vec::new();
    let mut outs = Vec::new();
    let mut take = |outs: &mut Vec<Out>, events: &mut Vec<HarnessEvent>| {
        for o in outs.drain(..) {
            match o {
                Out::Event(e) => events.push(e),
                Out::Io(step) => io.run(&step, events),
            }
        }
    };
    for (i, line) in lines.iter().enumerate() {
        parser.line(line, now(i), &mut outs);
        take(&mut outs, &mut events);
    }
    parser.close(exit, now(lines.len()), &mut outs);
    take(&mut outs, &mut events);
    events
}
