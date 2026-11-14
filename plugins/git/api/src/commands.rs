//! wisp.git's commands: what a client, an agent (MCP) or another plugin can ask of git by id, each with
//! the same permission as the service method it wraps (a service is never a back door, plan §6.11.1).
//! They take a folder (`path`): which folder a session works in is the worktrees plugin's business,
//! and its v1 routes (`/sessions/:id/changes…`) are thin adapters over these.

use serde::{Deserialize, Serialize};
use wisp_kernel::Command;

use crate::{Changes, Cloned, Status, Tools};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathArgs {
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesArgs {
    pub path: String,
    /// the ref the work left from (`origin/main`, a base branch, a sha)
    pub base: String,
    /// .env files shown unmasked (the page's Reveal)
    #[serde(default)]
    pub reveal: Vec<String>,
    /// .env masking on (v1 `defaults.maskEnvFiles` unless 'off')
    #[serde(default = "yes")]
    pub mask: bool,
    /// with each file's stage state
    #[serde(default = "yes")]
    pub stage_state: bool,
    /// files inline whatever their size (v1 routes); else past 512 KB they go as a blob ref
    #[serde(default)]
    pub inline: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertArgs {
    /// the folder (a worktree)
    pub dir: String,
    pub base: String,
    /// the file, relative to `dir`
    pub path: String,
    #[serde(default)]
    pub hunk: Option<usize>,
    #[serde(default)]
    pub key: Option<String>,
    /// Undo: the file's text from before (`Some(None)`: it wasn't there), if its hash is still `hash`
    #[serde(default, with = "double_option")]
    pub restore: Option<Option<String>>,
    #[serde(default)]
    pub hash: Option<String>,
}

/// `restore` absent, `null`, or a string: three different requests.
mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[allow(clippy::ref_option, clippy::option_option)]
    pub fn serialize<S: Serializer>(v: &Option<Option<String>>, s: S) -> Result<S::Ok, S::Error> {
        v.as_ref().map_or(Ok(None::<String>), |x| Ok(x.clone()))?.serialize(s)
    }
    #[allow(clippy::option_option)]
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
        Option::<String>::deserialize(d).map(Some)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reverted {
    pub ok: bool,
    /// sha1 of the file after (None: it's gone), for an Undo
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArgs {
    pub dir: String,
    pub base: String,
    pub path: String,
    #[serde(default)]
    pub hunk: Option<usize>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub unstage: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitArgs {
    pub dir: String,
    pub message: String,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Committed {
    pub ok: bool,
    /// the short sha
    pub sha: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    pub ok: bool,
}

macro_rules! command {
    ($name:ident, $id:literal, $perm:literal, $ro:literal, $args:ty, $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            const READ_ONLY: bool = $ro;
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(GetStatus, "git.status", "git:status", true, PathArgs, Status);
command!(GetChanges, "git.changes", "git:diff", true, ChangesArgs, Option<Changes>);
command!(Revert, "git.revert", "git:revert", false, RevertArgs, Reverted);
command!(Stage, "git.stage", "git:stage", false, StageArgs, Done);
command!(Commit, "git.commit", "git:commit", false, CommitArgs, Committed);
command!(GetTools, "git.tools", "git:read", true, (), Tools);
command!(GetOrigin, "git.origin", "git:read", true, crate::OriginArgs, crate::Origin);
command!(Checkout, "git.checkout", "git:clone", false, crate::CheckoutArgs, Cloned);
command!(Clone, "git.clone", "git:clone", false, crate::CloneRequest, Cloned);
