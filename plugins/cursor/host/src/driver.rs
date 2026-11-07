//! The run driver wisp.runtime drives for this harness: wisp-harness-kit's `Driver` (the sans-IO parser
//! plus its disk steps) over the runtime's `HarnessSys`, with kit events (v1's JSON) mapped onto the
//! runtime's `HarnessEvent`. Every harness host carries this same file: it belongs in one place above
//! the kit (wisp-runtime-api), and the harness report asks for that move.

use serde_json::Value;
use wisp_harness_kit::{self as kit, Disk, DiskFuture, Driver, LineParser, RunPaths};
use wisp_kernel::BoxFuture;
use wisp_runtime_api::HarnessEvent;
use wisp_runtime_api::harness::{ExecReq, HarnessSys, ParserInput, ParserOutput, RunDriver};

/// A kit parser as the runtime's `RunDriver`.
pub struct KitDriver<P> {
    inner: Driver<P>,
    /// pin the git base on the first input (harnesses that use the file tracker)
    track: bool,
    pinned: bool,
    events: Vec<kit::HarnessEvent>,
}

impl<P> std::fmt::Debug for KitDriver<P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KitDriver").field("track", &self.track).finish_non_exhaustive()
    }
}

impl<P: LineParser + 'static> KitDriver<P> {
    /// `track`: the parser emits tracker steps (`Remember`/`Changed`), so git is pinned before the
    /// first line is parsed. The runtime gives a driver no start-of-run call, so that is the earliest.
    pub fn boxed(parser: P, paths: RunPaths, track: bool) -> Box<dyn RunDriver> {
        Box::new(Self { inner: Driver::new(parser, paths), track, pinned: false, events: Vec::new() })
    }
}

impl<P: LineParser + 'static> RunDriver for KitDriver<P> {
    fn on<'a>(&'a mut self, input: ParserInput<'a>, now_ms: i64, sys: &'a dyn HarnessSys, out: &'a mut ParserOutput) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let disk = SysDisk(sys);
            if self.track && !self.pinned {
                self.pinned = true;
                self.inner.pin(&disk).await;
            }
            let mut events = std::mem::take(&mut self.events);
            match input {
                ParserInput::Stdout(line) => self.inner.stdout(line, now_ms, &disk, &mut events).await,
                ParserInput::Stderr(text) => self.inner.stderr(text, now_ms, &disk, &mut events).await,
                ParserInput::Exit(e) => {
                    let exit = kit::Exit { code: e.code, signal: e.signal.clone(), stderr: e.stderr.clone(), stopped: e.stopped, stop_requested: e.stop_requested };
                    self.inner.exit(&exit, now_ms, &disk, &mut events).await;
                }
                ParserInput::Stop | ParserInput::Reply { .. } => {}
            }
            for e in events.drain(..) {
                if let Some(m) = to_runtime(&e) {
                    out.emit(m);
                }
            }
            self.events = events;
        })
    }
}

/// The runtime's I/O as the kit's disk: files and git, through the proc service.
struct SysDisk<'s>(&'s dyn HarnessSys);

impl Disk for SysDisk<'_> {
    fn read(&self, abs: &str) -> DiskFuture<'_, Option<String>> {
        self.0.read_file(abs)
    }
    fn git<'a>(&'a self, cwd: &'a str, args: &'a [&'a str]) -> DiskFuture<'a, Option<String>> {
        let req = ExecReq { program: "git".into(), args: args.iter().map(|a| (*a).to_owned()).collect(), cwd: Some(cwd.to_owned()), timeout_ms: 10_000, ..ExecReq::default() };
        let run = self.0.exec(req);
        Box::pin(async move {
            match run.await {
                Ok(o) if o.code == Some(0) && !o.timed_out => Some(o.stdout),
                _ => None,
            }
        })
    }
}

/// Integer counters in the runtime's stats; v1 copied whatever the CLI sent.
const COUNTERS: [&str; 6] = ["durationMs", "turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

/// A kit event as the runtime's. v1 copied stats as the CLI sent them (null, a float); the runtime's
/// stats are typed, so nulls go, counters round, and a result whose stats still don't fit keeps its
/// text without them: a turn must never lose its result.
pub fn to_runtime(e: &kit::HarnessEvent) -> Option<HarnessEvent> {
    let mut v = e.to_json();
    if let Some(stats) = v.get_mut("stats").and_then(Value::as_object_mut) {
        stats.retain(|_, x| !x.is_null());
        for k in COUNTERS {
            if let Some(x) = stats.get(k).and_then(Value::as_f64) {
                if x >= 0.0 && x.is_finite() {
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    stats.insert(k.to_owned(), Value::from(x.round() as u64));
                } else {
                    stats.remove(k);
                }
            } else if stats.get(k).is_some() {
                stats.remove(k);
            }
        }
    }
    match HarnessEvent::from_v1(v.clone()) {
        Ok(m) => Some(m),
        Err(err) => {
            if let Some(o) = v.as_object_mut().filter(|o| o.contains_key("stats")) {
                o.remove("stats");
                if let Ok(m) = HarnessEvent::from_v1(v) {
                    tracing::warn!(error = %err.message, "harness result stats dropped");
                    return Some(m);
                }
            }
            tracing::warn!(error = %err.message, "harness event dropped");
            None
        }
    }
}
