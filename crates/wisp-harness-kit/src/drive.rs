//! Running a parser's IO steps in order, over whatever disk the host hands in. No runtime here: the
//! futures are plain `async`, and the [`Disk`] is the host's adapter over wisp.runtime's `HarnessSys`
//! (tests pass a map). Steps run one at a time where they stand, so the events keep v1's order.

use std::future::Future;

use crate::event::HarnessEvent;
use crate::parser::{Exit, IoStep, LineParser, Out};
use crate::paths::{MAX_SNAPSHOT, RunPaths, resolve};
use crate::protocol::write_change;
use crate::tracker::{Before, Tracker};

pub type DiskFuture<'a, T> = std::pin::Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The disk a driver may read: files and git, nothing else.
pub trait Disk: Send + Sync {
    /// The file's text, or None when it isn't a readable file.
    fn read(&self, abs: &str) -> DiskFuture<'_, Option<String>>;
    /// `git <args>` in `cwd`: its stdout when it exited 0.
    fn git<'a>(&'a self, cwd: &'a str, args: &'a [&'a str]) -> DiskFuture<'a, Option<String>> {
        self.git_env(cwd, args, &[])
    }
    /// `git <args>` in `cwd` with `env` added (a temporary `GIT_INDEX_FILE`): its stdout when it exited 0.
    /// Additive (2026-11-13).
    fn git_env<'a>(
        &'a self,
        cwd: &'a str,
        args: &'a [&'a str],
        env: &'a [(&'a str, &'a str)],
    ) -> DiskFuture<'a, Option<String>>;
    /// Removes a file wisp made (a temporary index); a missing one is fine. Additive (2026-11-13).
    fn remove<'a>(&'a self, abs: &'a str) -> DiskFuture<'a, ()>;
    /// Copies `from` to `to` byte for byte, read from one open file and with `from`'s mtime kept (git's
    /// racy-clean check compares an index's mtime with its entries'): true when it did. Additive
    /// (2026-11-13): the default copies nothing, and callers fall back to slower ways.
    fn copy<'a>(&'a self, from: &'a str, to: &'a str) -> DiskFuture<'a, bool> {
        let _ = (from, to);
        Box::pin(async { false })
    }
}

/// The file now when it is at most `max` bytes, else None (missing, not a file, too big).
pub async fn read_up_to(disk: &dyn Disk, abs: &str, max: usize) -> Option<String> {
    disk.read(abs).await.filter(|s| s.len() <= max)
}

/// The file now: None when it isn't one, '' when it is over `MAX_SNAPSHOT` (v1 `readSnapshot`).
pub async fn snapshot(disk: &dyn Disk, abs: &str) -> Option<String> {
    disk.read(abs).await.map(|s| {
        if s.len() <= MAX_SNAPSHOT {
            s
        } else {
            String::new()
        }
    })
}

/// The git base of a run: not looked up yet, or looked up (None: not a repo).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pin {
    Unpinned,
    Base(Option<String>),
}

/// A parser and the state its IO steps need (the file tracker, the git base pinned for the run).
#[derive(Debug)]
pub struct Driver<P> {
    parser: P,
    paths: RunPaths,
    tracker: Tracker,
    base: Pin,
    outs: Vec<Out>,
    stop: bool,
}

impl<P: LineParser> Driver<P> {
    pub fn new(parser: P, paths: RunPaths) -> Self {
        Self {
            parser,
            paths,
            tracker: Tracker::new(),
            base: Pin::Unpinned,
            outs: Vec::new(),
            stop: false,
        }
    }

    /// The parser asked to stop the process since the last call (once).
    pub fn take_stop(&mut self) -> bool {
        std::mem::take(&mut self.stop)
    }

    pub fn parser(&self) -> &P {
        &self.parser
    }

    /// Pins the git base the tracker diffs against (v1 pinned it before spawning): the tracked work in
    /// progress as a commit, written through a temporary index (never the user's: their `git commit`
    /// must not meet our `index.lock`), else HEAD. Idempotent.
    pub async fn pin(&mut self, disk: &dyn Disk) {
        if self.base != Pin::Unpinned {
            return;
        }
        let cwd = self.paths.cwd.clone();
        let base = match crate::wip::work_in_progress(disk, &cwd).await {
            Some(s) => Some(s),
            None => disk
                .git(&cwd, &["rev-parse", "--verify", "HEAD"])
                .await
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
        };
        self.base = Pin::Base(base);
    }

    pub async fn stdout(
        &mut self,
        line: &str,
        now_ms: i64,
        disk: &dyn Disk,
        events: &mut Vec<HarnessEvent>,
    ) {
        let mut outs = std::mem::take(&mut self.outs);
        self.parser.line(line, now_ms, &mut outs);
        self.take(&mut outs, disk, events).await;
        self.outs = outs;
    }

    pub async fn stderr(
        &mut self,
        text: &str,
        now_ms: i64,
        disk: &dyn Disk,
        events: &mut Vec<HarnessEvent>,
    ) {
        let mut outs = std::mem::take(&mut self.outs);
        self.parser.stderr(text, now_ms, &mut outs);
        self.take(&mut outs, disk, events).await;
        self.outs = outs;
    }

    pub async fn exit(
        &mut self,
        exit: &Exit,
        now_ms: i64,
        disk: &dyn Disk,
        events: &mut Vec<HarnessEvent>,
    ) {
        let mut outs = std::mem::take(&mut self.outs);
        self.parser.close(exit, now_ms, &mut outs);
        self.take(&mut outs, disk, events).await;
        self.outs = outs;
    }

    async fn take(&mut self, outs: &mut Vec<Out>, disk: &dyn Disk, events: &mut Vec<HarnessEvent>) {
        for o in outs.drain(..) {
            match o {
                Out::Event(e) => events.push(e),
                Out::Io(step) => self.run(&step, disk, events).await,
                Out::Stop => self.stop = true,
            }
        }
    }

    async fn run(&mut self, step: &IoStep, disk: &dyn Disk, events: &mut Vec<HarnessEvent>) {
        match step {
            IoStep::WriteBefore { abs, file, after } => {
                let before = read_up_to(disk, abs, MAX_SNAPSHOT).await;
                events.push(write_change(file, before.as_deref(), after));
            }
            IoStep::Remember { file } => {
                if self.tracker.wants_snapshot(file) {
                    let snap = snapshot(disk, &resolve(&self.paths.cwd, file)).await;
                    self.tracker.remembered(file, snap);
                }
            }
            IoStep::Changed { file } => {
                let after = snapshot(disk, &resolve(&self.paths.cwd, file)).await;
                let before = match self.tracker.before(file, after.as_deref()) {
                    Before::Known(b) => b,
                    Before::Git => self.at_base(file, disk).await,
                };
                events.extend(self.tracker.changed(file, before, after));
            }
            IoStep::ChangedElse { file, otherwise } => {
                let after = snapshot(disk, &resolve(&self.paths.cwd, file)).await;
                let before = match self.tracker.before(file, after.as_deref()) {
                    Before::Known(b) => b,
                    Before::Git => self.at_base(file, disk).await,
                };
                events.push(self.tracker.changed(file, before, after).unwrap_or_else(|| (**otherwise).clone()));
            }
            IoStep::Sync { file } => {
                let after = snapshot(disk, &resolve(&self.paths.cwd, file)).await;
                let before = match self.tracker.before(file, after.as_deref()) {
                    Before::Known(b) => b,
                    Before::Git => self.at_base(file, disk).await,
                };
                let _ = self.tracker.changed(file, before, after);
            }
        }
    }

    /// The file at the pinned base (pinning now if nothing did yet), '' past `MAX_SNAPSHOT`.
    async fn at_base(&mut self, file: &str, disk: &dyn Disk) -> Option<String> {
        if file.starts_with('/') {
            return None;
        }
        self.pin(disk).await;
        let Pin::Base(Some(base)) = self.base.clone() else {
            return None;
        };
        let spec = format!("{base}:./{file}");
        let cwd = self.paths.cwd.clone();
        let out = disk.git(&cwd, &["show", &spec]).await?;
        Some(if out.len() <= MAX_SNAPSHOT {
            out
        } else {
            String::new()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MapDisk {
        files: Mutex<HashMap<String, String>>,
        git: HashMap<String, String>,
    }

    impl Disk for MapDisk {
        fn read(&self, abs: &str) -> DiskFuture<'_, Option<String>> {
            let v = self.files.lock().ok().and_then(|m| m.get(abs).cloned());
            Box::pin(async move { v })
        }
        fn git_env<'a>(&'a self, _cwd: &'a str, args: &'a [&'a str], _env: &'a [(&'a str, &'a str)]) -> DiskFuture<'a, Option<String>> {
            let v = self.git.get(&args.join(" ")).cloned();
            Box::pin(async move { v })
        }
        fn remove<'a>(&'a self, _abs: &'a str) -> DiskFuture<'a, ()> {
            Box::pin(async {})
        }
    }

    /// Announces `a.js` on "announce", reports it written on "wrote", and a Write of b.js on "write".
    struct Script;
    impl LineParser for Script {
        fn line(&mut self, line: &str, _now: i64, out: &mut Vec<Out>) {
            match line {
                "announce" => out.push(Out::Io(IoStep::Remember {
                    file: "a.js".into(),
                })),
                "wrote" => out.push(Out::Io(IoStep::Changed {
                    file: "a.js".into(),
                })),
                "write" => out.push(Out::Io(IoStep::WriteBefore {
                    abs: "/w/b.js".into(),
                    file: "b.js".into(),
                    after: "new b".into(),
                })),
                _ => out.push(Out::Event(HarnessEvent::text(line))),
            }
        }
        fn close(&mut self, _exit: &Exit, _now: i64, _out: &mut Vec<Out>) {}
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        // The disk above answers at once: one poll finishes every future.
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        let mut f = std::pin::pin!(f);
        loop {
            if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    #[test]
    fn steps_run_in_place() {
        let disk = MapDisk::default();
        if let Ok(mut m) = disk.files.lock() {
            m.insert("/w/a.js".into(), "old a".into());
            m.insert("/w/b.js".into(), "old b".into());
        }
        let mut d = Driver::new(Script, RunPaths::same("/w"));
        let mut ev = Vec::new();
        block_on(async {
            d.stdout("hi", 0, &disk, &mut ev).await;
            d.stdout("announce", 1, &disk, &mut ev).await;
            if let Ok(mut m) = disk.files.lock() {
                m.insert("/w/a.js".into(), "new a".into());
            }
            d.stdout("wrote", 2, &disk, &mut ev).await;
            d.stdout("write", 3, &disk, &mut ev).await;
        });
        let json: Vec<_> = ev.iter().map(HarnessEvent::to_json).collect();
        assert_eq!(json[0]["text"], "hi");
        assert_eq!(
            (
                json[1]["op"].as_str(),
                json[1]["edits"][0]["before"].as_str(),
                json[1]["edits"][0]["after"].as_str()
            ),
            (Some("write"), Some("old a"), Some("new a"))
        );
        assert_eq!(
            (
                json[2]["op"].as_str(),
                json[2]["early"].as_bool(),
                json[2]["edits"][0]["before"].as_str()
            ),
            (Some("write"), Some(true), Some("old b"))
        );
    }
}
