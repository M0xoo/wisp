//! A run: what a turn hands its harness, what to spawn, and the sans-IO parser seam.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::BoxFuture;

use super::{HarnessEvent, HarnessSys};
use crate::model::{Attachment, Mode};

// ---------- a run ----------

/// Everything a turn hands its harness (v1 `adapter.run({...})`, by the same names). Each optional so a
/// harness with no use for one ignores it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // v1's `adapter.run({...})` options, one for one
pub struct HarnessRun {
    /// the task and turn, for logs and the env (`WISP_TASK`)
    pub session_id: String,
    pub turn_id: String,
    pub prompt: String,
    pub attachments: Vec<Attachment>,
    pub cwd: String,
    pub dirs: Vec<String>,
    pub resume_id: Option<String>,
    pub fork: bool,
    pub mode: Mode,
    pub model: String,
    pub effort: String,
    pub system_prompt: String,
    pub mcp_servers: BTreeMap<String, Value>,
    /// `rule`s from its own blocked events the user allowed, for this turn only
    pub grants: Vec<String>,
    /// what every process of the run inherits (`WISP_TASK`, `WISP_URL`, the agent token)
    pub env: BTreeMap<String, String>,
    /// the account it runs on (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); empty for the CLI's own
    pub account_env: BTreeMap<String, String>,
    /// the conversation's counters after its last turn, to count this one alone
    pub prior: Option<Value>,
    /// a chat that ran elsewhere (bring-in): the first result is the baseline
    pub unknown_prior: bool,
    /// a lead with a team delegates through wisp: the harness's own subagent tool is off
    pub delegating: bool,
    /// a side run that only answers: no tools, no MCP, the CLI's base prompt swapped
    pub lean: bool,
    /// a repo the user hasn't trusted: none of its hooks or MCP servers
    pub untrusted: bool,
    /// without the CLI's nonessential traffic (v1 lean.js `LEAN_ENV`)
    pub quiet: bool,
    /// the model its subagents run on ('' | 'haiku' | 'sonnet')
    pub subagent_model: String,
    /// "off": without its slash commands and skills
    pub skills: String,
    /// every write and command goes to the approve tool first
    pub gate: bool,
    /// started from a channel with a mode cap: the sandbox keeps the shell off wisp's API
    pub capped: bool,
    /// a task's turn: check what the CLI is and what the sign-in bills to (side runs skip it)
    pub probe: bool,
    /// the program detect found (`HarnessFound::bin`), if any
    pub bin: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum Stdin {
    /// /dev/null
    #[default]
    Null,
    /// written once, then closed (a prompt too long for argv)
    Bytes(Vec<u8>),
    /// kept open: the parser writes to it (JSON-RPC harnesses, stream-json input)
    Pipe,
}

/// A file the runtime writes before spawning and removes after the run (an MCP config, a prompt file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchFile {
    /// relative: under the run's private temp folder; the runtime puts `{tmp}` in argv/env for it
    pub path: String,
    pub contents: String,
}

/// What to spawn for a run. Plain data: the runtime spawns it through wisp-proc.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    /// added to the inherited env (run env + account env are merged by the runtime first)
    pub env: BTreeMap<String, String>,
    pub env_remove: Vec<String>,
    pub cwd: String,
    pub stdin: Stdin,
    /// run on a pseudo-terminal (a CLI that only streams on a tty)
    pub pty: bool,
    pub files: Vec<LaunchFile>,
    /// how long Stop waits after `StopHow::Interrupt` before terminating the tree
    pub stop_grace_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopHow {
    /// SIGINT the process (the CLI ends its turn and prints a result)
    Interrupt,
    /// SIGTERM the tree, SIGKILL after the grace
    Terminate,
}

/// How the process ended (v1 spawnJsonl's `onClose`; the same fields as wisp-harness-kit's `Exit`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

/// What a parser hears. Lines arrive without their trailing newline, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserInput<'a> {
    Stdout(&'a str),
    Stderr(&'a str),
    /// the user pressed Stop (the parser may answer with a stdin write or a `StopHow`)
    Stop,
    /// a live approval or an ask came back, for harnesses that take it on stdin
    Reply {
        id: &'a str,
        body: &'a Value,
    },
    /// the process exited; the parser emits its final `Result` now if it hasn't
    Exit(&'a Exit),
}

/// What a parser asks for in answer to one input.
#[derive(Debug, Default, PartialEq)]
pub struct ParserOutput {
    pub events: Vec<HarnessEvent>,
    /// bytes to write to stdin (with `Stdin::Pipe`), in order
    pub writes: Vec<Vec<u8>>,
    pub close_stdin: bool,
    pub stop: Option<StopHow>,
}

impl ParserOutput {
    pub fn emit(&mut self, e: HarnessEvent) {
        self.events.push(e);
    }
    pub fn write(&mut self, bytes: impl Into<Vec<u8>>) {
        self.writes.push(bytes.into());
    }
}

/// A sans-IO parser for one run: no clock, no files, no sockets. Must emit exactly one `Result`, by
/// `Exit` at the latest (the runtime makes one up from stderr if it doesn't, and logs that).
pub trait HarnessParser: Send {
    fn on(&mut self, input: ParserInput<'_>, now_ms: i64, out: &mut ParserOutput);
}

/// What the runtime drives for one run. Async only so a harness can run its parser's disk steps (through
/// `sys`, never directly) in order; it must not block, and must not hold `sys` calls across inputs.
pub trait RunDriver: Send {
    fn on<'a>(
        &'a mut self,
        input: ParserInput<'a>,
        now_ms: i64,
        sys: &'a dyn HarnessSys,
        out: &'a mut ParserOutput,
    ) -> BoxFuture<'a, ()>;
}

/// A pure parser as a driver (no disk steps).
pub fn pure(parser: impl HarnessParser + 'static) -> Box<dyn RunDriver> {
    Box::new(Pure(parser))
}

struct Pure<P>(P);

impl<P: HarnessParser> RunDriver for Pure<P> {
    fn on<'a>(
        &'a mut self,
        input: ParserInput<'a>,
        now_ms: i64,
        _sys: &'a dyn HarnessSys,
        out: &'a mut ParserOutput,
    ) -> BoxFuture<'a, ()> {
        self.0.on(input, now_ms, out);
        Box::pin(std::future::ready(()))
    }
}
