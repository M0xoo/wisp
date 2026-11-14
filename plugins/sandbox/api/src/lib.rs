//! wisp.sandbox's contract (ADR-0047): a sandbox on the user's wisp Grid for one owner (a task, a delegate, a crew
//! job or member, a goal's judges), made and seeded with the project, deleted with its owner.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Command;

pub const PLUGIN_ID: &str = "wisp.sandbox";

/// `/sandbox <prompt>` in New task: the task runs in a sandbox of its own.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub prompt: String,
    /// the project that goes along (none: an empty folder there)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// a goal for it (as `runtime.create` takes one): its judges run in the sandbox too
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launched {
    /// the sandbox's machine here
    pub machine: String,
    /// its peer id (the task's key is `<peer>:<task>`)
    pub peer: String,
    pub task: String,
    pub sandbox: String,
}

/// A seeded sandbox for an owner (a delegate, a crew job or member, a goal's judges): made, or the one it has.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceArgs {
    /// `{task}`, `{lead, member}`, `{crew, job}`, `{crew}` or `{judges}` (wisp-sandbox-core `Owner`)
    pub owner: Value,
    /// the folder whose work goes along
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub machine: String,
    pub peer: String,
    pub sandbox: String,
    /// the project's folder in the sandbox
    pub cwd: String,
    /// false: the owner's sandbox from before
    pub made: bool,
}

/// What a sandbox's own wisp takes in: the project as a bundle, its uncommitted changes, its origin and author.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedArgs {
    pub name: String,
    /// `git bundle create --all`, base64
    pub bundle: String,
    /// `git diff HEAD --binary`
    #[serde(default)]
    pub patch: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub author_email: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seeded {
    pub cwd: String,
    /// what `.wisp/sandbox.sh` said, when it ran (once)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropArgs {
    /// a task: its sandboxes, its judges' and delegates'
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// a crew member: theirs and their jobs'
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crew: Option<String>,
    /// one sandbox, by its machine
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// A sandbox's owner, once it's known (a crew job's sandbox, owned by the job's task once it exists).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OwnArgs {
    pub machine: String,
    pub owner: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dropped {
    pub dropped: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Empty {}

/// A project's changes in a sandbox since it came in (`sandbox.patch`, inside), or brought back here (`sandbox.bring`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchArgs {
    pub cwd: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Patch {
    pub patch: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BringArgs {
    pub machine: String,
    /// the project's folder in the sandbox
    pub from: String,
    /// the folder here it goes into
    pub into: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brought {
    /// files the changes touched (0: nothing changed there)
    pub files: u32,
    /// why they couldn't go in (they clash with changes here)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One sandbox as Settings → Cloud → Sandboxes lists it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxView {
    pub machine: String,
    pub peer: String,
    pub sandbox: String,
    pub name: String,
    pub owner: Value,
    pub state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// this grid makes sandboxes, and this computer is signed in to it
    pub enabled: bool,
    /// why not, when it doesn't
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// sign-ins every sandbox starts with (`claude`)
    pub logins: Vec<String>,
    /// env var names every sandbox gets (values never come back)
    pub env: Vec<String>,
    pub sandboxes: Vec<SandboxView>,
}

/// `claude setup-token` on a pty here: its link first, then the code pasted back, then the token goes to the grid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSignIn {
    /// waiting (for its link), link (open it, paste the code), done, failed
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeArgs {
    pub code: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvArgs {
    pub key: String,
    /// empty: the variable goes
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentArgs {
    pub agent: String,
}

macro_rules! command {
    ($name:ident = $id:literal : $args:ty => $out:ty $(, $ro:ident)?) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(Launch = "sandbox.launch" : LaunchArgs => Launched);
command!(Place = "sandbox.place" : PlaceArgs => Placed);
command!(Seed = "sandbox.seed" : SeedArgs => Seeded);
command!(Drop = "sandbox.drop" : DropArgs => Dropped);
command!(Own = "sandbox.own" : OwnArgs => Empty);
command!(PatchCmd = "sandbox.patch" : PatchArgs => Patch, ro);
command!(Bring = "sandbox.bring" : BringArgs => Brought);
command!(InfoCmd = "sandbox.info" : Empty => Info, ro);
command!(ClaudeBegin = "sandbox.claude.begin" : Empty => ClaudeSignIn);
command!(ClaudeCode = "sandbox.claude.code" : CodeArgs => ClaudeSignIn);
command!(ClaudeState = "sandbox.claude.state" : Empty => ClaudeSignIn, ro);
command!(Logout = "sandbox.logout" : AgentArgs => Info);
command!(Env = "sandbox.env" : EnvArgs => Info);
