//! wisp-history-api: the contract of `wisp.history` (ADR-0033, 0035, 0042): a repo's agent history in
//! `.wisp/`. Commands track and untrack tasks, answer blame and the log, hold ask-mode offers and resume
//! requests; two points let a plugin replace where history is kept (`history.store@1`) and what knows who
//! wrote a line (`history.blame@1`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Command, Point, Result};

pub const PLUGIN: &str = "wisp.history";
/// The task ext slot this plugin owns: `{ tracked: { repo, files, store }, offer: bool }`.
pub const EXT: &str = "wisp.history";

/// Where a tracked task's files go. `rel` paths are relative to the repo's `.wisp/`.
pub trait HistoryStore: Send + Sync + 'static {
    /// `files`, `notes`, `lfs`, or a plugin's own
    fn id(&self) -> &'static str;
    /// Writes (or rewrites) these files. → what it wrote, as the repo sees it.
    fn write(&self, root: PathBuf, files: Vec<(String, Vec<u8>)>) -> BoxFuture<'static, Result<Vec<String>>>;
    /// Removes these files (those not there are skipped). → what went.
    fn remove(&self, root: PathBuf, rels: Vec<String>) -> BoxFuture<'static, Result<Vec<String>>>;
    /// One file back, if it's kept.
    fn read(&self, root: PathBuf, rel: String) -> BoxFuture<'static, Option<Vec<u8>>>;
}

pub const STORE: Point<dyn HistoryStore> = Point::new("history.store", 1);

/// What knows which commit wrote a line, and which commits touched a path.
pub trait BlameSource: Send + Sync + 'static {
    /// `git`, `jj`, …
    fn id(&self) -> &'static str;
    /// (commit, lines) for `file`, or for `range` (1-based, inclusive) of it, as it is now.
    fn blame(&self, root: PathBuf, file: String, range: Option<(u32, u32)>) -> BoxFuture<'static, Vec<(String, u32)>>;
    /// A commit's whole message.
    fn message(&self, root: PathBuf, sha: String) -> BoxFuture<'static, String>;
    /// The commits that touched `path` ("" for all), newest first; or a range's (`a..b`), or one commit.
    fn commits(&self, root: PathBuf, spec: String, path: String) -> BoxFuture<'static, Vec<String>>;
    /// The commits whose message has `needle`.
    fn grep(&self, root: PathBuf, needle: String) -> BoxFuture<'static, Vec<String>>;
    /// (path, lines added) of a commit.
    fn added(&self, root: PathBuf, sha: String) -> BoxFuture<'static, Vec<(String, u32)>>;
    /// Whether `root` is under this source at all.
    fn knows(&self, root: PathBuf) -> BoxFuture<'static, bool>;
}

pub const BLAME: Point<dyn BlameSource> = Point::new("history.blame", 1);

macro_rules! command {
    ($ty:ident, $id:literal, $args:ty, $out:ty $(, read_only = $ro:literal)?) => {
        #[derive(Debug)]
        pub struct $ty;
        impl Command for $ty {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = $ro;)?
            type Args = $args;
            type Out = $out;
            fn args_ts() -> Option<String> {
                Some(format!("{}{}", <$args as ::ts_rs::TS>::docs().unwrap_or_default(), <$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
            }
        }
    };
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TrackArgs {
    pub id: String,
    /// full (the default), report or spec
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// the repo (default: the task's folder's)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracked {
    pub repo: String,
    pub store: String,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<String>,
    pub commits: Vec<String>,
    pub scrubbed: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct UntrackArgs {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// report (drop the transcript) or spec (drop both)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gone {
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct BlameArgs {
    pub target: String,
    pub repo: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Empty {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRequestArgs {
    pub id: String,
    /// who asks (an agent in Claude Code, a teammate)
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRequest {
    pub id: String,
    pub task: String,
    pub title: String,
    pub by: String,
    pub why: String,
    pub repo: String,
    pub at: i64,
    /// pending, approved, denied
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct AnswerArgs {
    pub request: String,
    pub approve: bool,
}

command!(Track, "history.track", TrackArgs, Tracked);
command!(Save, "history.save", TrackArgs, Tracked);
command!(Untrack, "history.untrack", UntrackArgs, Gone);
command!(BlameCmd, "history.blame", BlameArgs, Value, read_only = true);
command!(ResumeRequestCmd, "history.resumeRequest", ResumeRequestArgs, ResumeRequest);
command!(ResumeAnswer, "history.resumeAnswer", AnswerArgs, ResumeRequest);
command!(Requests, "history.requests", Empty, Vec<ResumeRequest>, read_only = true);
