//! `runtime.harness@1`: what each CLI plugin (wisp.claude, wisp.codex, …) contributes. The port of v1's
//! adapter shape (server/adapters/index.js), with one change: **a harness does no I/O for a run.**
//!
//! A run is a [`Launch`] (argv, env, stdin: plain data the harness builds from a [`HarnessRun`]) plus a
//! [`RunDriver`] that turns the process's output into [`HarnessEvent`]s. wisp.runtime spawns the launch
//! through wisp-proc's service, frames stdout into lines, feeds the driver, and owns stop, timeouts and
//! the process tree. Switching a harness off frees nothing it could leak.
//!
//! The parser itself is sans-IO ([`HarnessParser`]: lines in, events and stdin writes out; time comes in
//! as `now_ms`), so it is tested with recorded transcripts and no CLI installed. A harness whose parser
//! needs the disk mid-stream (the file as it was before a write: wisp-harness-kit's `IoStep`) wraps it in
//! a [`RunDriver`], which runs those steps in order through [`HarnessSys`]; a pure parser is wrapped by
//! [`pure`]. Anything else that needs I/O (detect, trust, has-session, live limits) also goes through
//! [`HarnessSys`], which the runtime implements over the proc service and tests replace with a fake.
//!
//! Wire compatibility: the JSON of wisp-harness-kit's `HarnessEvent` (v1's `onEvent` shapes) deserializes
//! into this crate's [`HarnessEvent`] unchanged (`HarnessEvent::from_v1`).

mod event;
mod info;
mod run;

use std::collections::BTreeMap;

use serde_json::Value;
use wisp_kernel::{BoxFuture, Point, Result};

pub use event::*;
pub use info::*;
pub use run::*;

use crate::model::Mode;

/// The point every harness plugin contributes one `Arc<dyn Harness>` to.
pub const HARNESS: Point<dyn Harness> = Point::new("runtime.harness", 1);

// ---------- the I/O a harness may ask for outside a run ----------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOut {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecReq {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
    pub stdin: Option<Vec<u8>>,
    pub timeout_ms: u64,
}

/// The runtime's I/O for harness plugins (detect, trust, has-session): implemented over wisp-proc, faked
/// in tests. Every call is async, never blocking the runtime.
pub trait HarnessSys: Send + Sync {
    fn exec(&self, req: ExecReq) -> BoxFuture<'_, Result<ExecOut>>;
    /// the first `program` on PATH (or the `WISP_<ID>_BIN` override), if any
    fn which(&self, program: &str) -> BoxFuture<'_, Option<String>>;
    fn read_file(&self, path: &str) -> BoxFuture<'_, Option<String>>;
    /// the CLI's own config (trusting a folder): written atomically
    fn write_file(&self, path: &str, contents: String) -> BoxFuture<'_, Result<()>>;
    fn list_dir(&self, path: &str) -> BoxFuture<'_, Vec<String>>;
    fn env(&self, name: &str) -> Option<String>;
    fn home(&self) -> String;
    /// 'darwin' | 'linux' | 'win32' (v1 names)
    fn platform(&self) -> String;
}

// ---------- the trait ----------

/// One per CLI. Only `info`, `detect`, `launch` and `parser` are required; the rest default to "not
/// supported", as v1's optional adapter fields did.
pub trait Harness: Send + Sync + 'static {
    fn info(&self) -> &HarnessInfo;

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound>;

    /// What to spawn for this run. Refuse (`invalid`) a run it can't do (a fork without `info().fork`).
    fn launch(&self, run: &HarnessRun) -> Result<Launch>;

    /// A fresh driver for this run (`pure(parser)` for a parser with no disk steps).
    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver>;

    /// The program a run starts (what detect found, else the CLI's name): what wisp.accounts' harness
    /// watch pins. None: the harness has no program of its own. Additive (2026-11-08).
    fn program(&self) -> Option<String> {
        None
    }
    /// How to get it on that OS, sent while it isn't found.
    fn setup(&self, _platform: &str) -> Option<SetupTip> {
        None
    }
    /// What the CLI really runs instead of that model in that mode, where it's known to.
    fn model_override(&self, _model: &str, _mode: Mode) -> Option<ModelOverride> {
        None
    }
    /// What a live approval is about (with `info().approve_tool`).
    fn permission(&self, _tool: &str, _input: &Value, _cwd: &str) -> Option<PermissionAsk> {
        None
    }
    /// argv to continue the conversation interactively (Take over, terminal sessions).
    fn resume_command(&self, _o: &ResumeOptions) -> Option<ResumeCommand> {
        None
    }
    /// Record `dir` as trusted in the CLI's own config, for one whose trust question no flag skips.
    fn trust<'a>(&'a self, _sys: &'a dyn HarnessSys, _dir: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    /// Whether the CLI kept conversation `id`; None: it can't tell.
    fn has_session<'a>(
        &'a self,
        _sys: &'a dyn HarnessSys,
        _id: &'a str,
        _cwd: &'a str,
    ) -> BoxFuture<'a, Option<bool>> {
        Box::pin(async { None })
    }
    /// The newest conversation the CLI kept for this folder (bring-in).
    fn latest_session<'a>(
        &'a self,
        _sys: &'a dyn HarnessSys,
        _cwd: &'a str,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    /// A read of the account's usage windows that spends nothing.
    fn live_limits<'a>(
        &'a self,
        _sys: &'a dyn HarnessSys,
        _env: &'a BTreeMap<String, String>,
    ) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }
    fn login(&self) -> Option<&HarnessLogin> {
        None
    }
    /// From what `login().status` printed: Some(true|false), or None when the answer isn't one we know.
    fn signed_in(&self, _out: &str, _code: Option<i32>) -> Option<bool> {
        None
    }
    /// What a run says when it is signed out (from real runs on an empty HOME).
    fn auth_failed(&self, _text: &str) -> bool {
        false
    }
    /// Who a login is, from what `status` printed: (email, plan).
    fn who_is(&self, _status_out: &str) -> Option<(Option<String>, Option<String>)> {
        None
    }
    fn accounts(&self) -> Option<&HarnessAccounts> {
        None
    }
    fn keys(&self) -> Option<&HarnessKeys> {
        None
    }
    /// The npm package wisp can install it from into its own tools folder (opencode). Additive
    /// (2026-11-08).
    fn npm_package(&self) -> Option<String> {
        None
    }
    /// Signs out where the CLI has no sign-out command (agy keeps its login in the keychain or a
    /// file). None: use `login().logout`. Additive (2026-11-08).
    fn sign_out<'a>(&'a self, _sys: &'a dyn HarnessSys) -> Option<BoxFuture<'a, Result<()>>> {
        None
    }
    fn folders(&self, _q: &FolderQuery) -> Option<HarnessFolders> {
        None
    }
}

impl std::fmt::Debug for dyn Harness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Harness")
            .field("id", &self.info().id)
            .finish_non_exhaustive()
    }
}

/// Feeds a whole recorded transcript through a pure parser (line `i` at `now_ms = i`): what parser
/// goldens and parity tests call.
pub fn replay(parser: &mut dyn HarnessParser, stdout: &str, exit: &Exit) -> ParserOutput {
    let mut out = ParserOutput::default();
    let mut n = 0;
    for line in stdout.lines() {
        parser.on(ParserInput::Stdout(line), n, &mut out);
        n += 1;
    }
    parser.on(ParserInput::Exit(exit), n, &mut out);
    out
}
