//! The plain data that crosses git.service@1 (plan §6.11.1: values that serialise, blob refs for large
//! results, nothing mutable shared). Shapes follow v1's JSON (server/git.js) on the wire, camelCase, so the
//! v1 routes stay thin adapters and v1 clients keep reading them. `ts-rs` exports what the UI reads.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a handle points at: the folder asked for, its worktree's top, and the main checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct RepoInfo {
    /// the path `repo()` was given, canonical
    pub path: String,
    /// `rev-parse --show-toplevel` of that path (a linked worktree's own folder)
    pub top: String,
    /// the main checkout (the parent of `--git-common-dir`): where worktrees are added from
    pub root: String,
    /// `path` relative to `top`, "" at the top: a launch from a subfolder keeps that subfolder
    pub sub: String,
}

/// One line of `git status --porcelain=v2`: `xy` is git's two-letter code (`.M`, `A.`, `??`, `UU`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct StatusEntry {
    pub path: String,
    pub xy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct Status {
    /// the checked-out branch, "" when detached
    pub branch: String,
    /// HEAD's sha, "" in a repo without commits
    pub head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// changed paths, untracked included (v1's `dirty` count is `entries.len()`)
    pub entries: Vec<StatusEntry>,
    /// unmerged paths (both sides changed them)
    pub conflicted: u32,
}

impl Status {
    pub fn dirty(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct Branch {
    pub name: String,
    pub sha: String,
    /// a remote-tracking branch (`origin/main`)
    pub remote: bool,
    pub current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream: Option<String>,
}

/// One entry of `git worktree list --porcelain`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct WorktreeEntry {
    pub path: String,
    pub head: String,
    /// "" when detached
    pub branch: String,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// What a worktree session branches from (edge case Git 4): origin/HEAD, origin/main, origin/master,
/// else HEAD with no remote. None in a repo without commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct BaseRef {
    /// what to branch from: `origin/main`, or a sha
    #[serde(rename = "ref")]
    pub reference: String,
    /// its branch name (`main`), "" for a detached HEAD
    pub branch: String,
    pub remote: Option<String>,
    /// the commit it resolved to
    pub sha: String,
}

/// A row of a file's diff as the page draws it: `op` is ' ', '+', '-', or '…' for a gap of `count`
/// unchanged lines. `a`/`b` are the line numbers in the old and new file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "git/")]
pub struct Row {
    pub op: char,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub a: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub b: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub count: Option<u32>,
}

impl Row {
    pub fn gap(count: u32) -> Self {
        Self {
            op: '…',
            text: None,
            a: None,
            b: None,
            count: Some(count),
        }
    }
    pub fn added(text: impl Into<String>, b: u32) -> Self {
        Self {
            op: '+',
            text: Some(text.into()),
            a: None,
            b: Some(b),
            count: None,
        }
    }
    pub fn removed(text: impl Into<String>, a: u32) -> Self {
        Self {
            op: '-',
            text: Some(text.into()),
            a: Some(a),
            b: None,
            count: None,
        }
    }
    pub fn context(text: impl Into<String>, a: u32, b: u32) -> Self {
        Self {
            op: ' ',
            text: Some(text.into()),
            a: Some(a),
            b: Some(b),
            count: None,
        }
    }
    pub fn text(&self) -> &str {
        self.text.as_deref().unwrap_or("")
    }
}

/// One file of a diff (v1 parseDiff): status A/M/D/R, counts, rows capped at 2000 (`more` past that).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct FileDiff {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
    pub status: char,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
    pub rows: Vec<Row>,
    pub more: u32,
    /// lockfiles, dist/, *.min.js: folded by the page
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub generated: bool,
    /// has changes in the index (Changes' stage state, filled by the stage read)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub staged: Option<bool>,
    /// has changes still to stage (untracked counts)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unstaged: Option<bool>,
    /// per hunk of `rows`, for a file staged hunk by hunk
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hunk_stage: Option<Vec<HunkStage>>,
    /// a .env file's values shown as KEY=•••• (the page's Reveal asks for it unmasked)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub masked: bool,
}

impl FileDiff {
    pub fn new(path: impl Into<String>, status: char) -> Self {
        Self {
            path: path.into(),
            from: None,
            status,
            add: 0,
            del: 0,
            binary: false,
            rows: Vec::new(),
            more: 0,
            generated: false,
            staged: None,
            unstaged: None,
            hunk_stage: None,
            masked: false,
        }
    }
    pub fn stat(&self) -> FileStat {
        FileStat {
            path: self.path.clone(),
            status: self.status,
            add: self.add,
            del: self.del,
            binary: self.binary,
            generated: self.generated,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "git/")]
pub struct HunkStage {
    pub unstaged: bool,
    pub staged: bool,
}

/// A file's counts without its rows: what a list shows before the rows load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct FileStat {
    pub path: String,
    pub status: char,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub generated: bool,
}

/// A large result stored in the content-addressed blob store (plan §6.11.1): fetch it by hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct BlobRef {
    /// blake3, hex
    pub hash: String,
    pub size: u64,
    pub media: String,
}

/// The files of a diff: inline when small, else a blob ref to their JSON (`Vec<FileDiff>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub enum Body {
    Inline { files: Vec<FileDiff> },
    Blob { blob: BlobRef },
}

/// The side panel's Changes (edge case Git 10): every file the work changed since it left `base`,
/// committed or not, untracked files whole. `at` is the merge-base sha.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct Changes {
    pub base: String,
    pub at: String,
    pub stats: Vec<FileStat>,
    pub body: Body,
    /// untracked files past the 200 sent whole
    pub untracked: u32,
    /// files with staged changes (set with the stage state)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub staged: Option<u32>,
}

/// `git merge-tree --write-tree` read (edge case Git 9): exit 0 clean, exit 1 conflict with the
/// conflicted paths, any other exit "can't tell" (git < 2.38).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub enum MergeTree {
    Clean,
    Conflict { files: Vec<String> },
    Unknown,
}

/// What a task touched since `base` (v1 touchedFiles): `head` is a commit of the work as it stands
/// (`stash create` when there are edits, so a merge-tree sees them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct Touched {
    pub files: Vec<String>,
    pub head: String,
    pub base: String,
}

/// After an agent was asked to merge the base in: is it in, with nothing half done?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct BaseMerged {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
}

/// What changed in a repo, told to `on_change` subscribers. `kind`: status, head, branches, worktrees,
/// fetched. Writes made through the service announce themselves; others come from `Repo::touch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "git/")]
pub struct RepoChange {
    pub root: String,
    pub path: String,
    pub kind: String,
}
