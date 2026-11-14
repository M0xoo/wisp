//! wisp-share-api: sharing a task (ADR-0027 "Sharing in practice"). A share is one `.wisp-task` file:
//! the spec, the formula snapshot it ran with (ADR-0029), and for `report` / `full` its answers, the files
//! it changed and (`full`) its history, all redacted before anything leaves, signed with the sharer's key,
//! with the wisp version and the harnesses it needs.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Command;

pub const PLUGIN_ID: &str = "wisp.share";
/// The bundle format this build writes and reads (`wispTask: 1`).
pub const FORMAT: u32 = 1;
pub const EXTENSION: &str = "wisp-task";

/// What a share holds, smallest first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// the ask and the setup: reproducible, nothing of the output
    #[default]
    Spec,
    /// the spec plus the answers (blocks) and the files changed, read-only
    Report,
    /// the spec plus the whole history, transcript included, for debugging together
    Full,
}

/// One thing taken out before a share leaves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Redaction {
    /// secret | env | path | name
    pub kind: String,
    /// where in the bundle (`spec/prompt`, `history/3/text`)
    pub at: String,
    /// what it was, shortened so the preview doesn't show it whole (`sk-…a1b2`)
    pub was: String,
    /// what it is now (`<secret>`, `<project>/src/a.ts`)
    pub now: String,
}

/// Who signed a bundle.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signer {
    pub name: String,
    /// the ed25519 public key, base64
    pub key: String,
}

/// A `.wisp-task` bundle.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub wisp_task: u32,
    /// its id (`sharedFrom` on what's made from it)
    pub id: String,
    pub level: Level,
    pub title: String,
    #[serde(default)]
    pub created_at: i64,
    /// the wisp version that made it
    pub version: String,
    /// what it needs to run here: `harness:codex`, `plugin:wisp.workflows`
    #[serde(default)]
    pub needs: Vec<String>,
    /// the task's spec (runtime's `TaskSpec`)
    pub spec: Value,
    /// the formula snapshot it ran with (`agents`, `connectors`, …)
    #[serde(default)]
    pub formula: Value,
    /// report and full: its answers' blocks and the files it changed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
    /// full: its turns and their steps
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Value>,
    /// how many things were redacted, by kind (the list stays with the sharer)
    #[serde(default)]
    pub redacted: Value,
    #[serde(default)]
    pub from: Signer,
    /// ed25519 over the bundle's canonical bytes without `sig`, base64
    #[serde(default)]
    pub sig: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ShareArgs {
    pub id: String,
    #[serde(default)]
    pub level: Level,
}

/// `share.preview`: exactly what goes, and every redaction.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Preview {
    pub bundle: Bundle,
    pub redactions: Vec<Redaction>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OpenArgs {
    pub bundle: Bundle,
}

/// `share.open`: what a bundle is and whether it can run here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Opened {
    /// the signature is the signer's, over these exact contents
    pub verified: bool,
    pub signer: Signer,
    /// the signer's key fingerprint (first 16 hex of blake-free sha: the key's base64, shortened)
    pub fingerprint: String,
    pub level: Level,
    pub title: String,
    /// what it needs that this wisp doesn't have
    pub missing: Vec<String>,
    pub bundle: Bundle,
}

macro_rules! command {
    ($name:ident = $id:literal [$perm:literal] $(read $ro:ident)? : $args:ty => $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(PreviewCmd = "share.preview" ["share:make"] read yes : ShareArgs => Preview);
command!(Make = "share.bundle" ["share:make"] : ShareArgs => Bundle);
command!(Open = "share.open" ["share:open"] read yes : OpenArgs => Opened);
command!(Import = "share.import" ["share:open"] : OpenArgs => Value);

/// What goes to a destination: the content's exact bytes, signed with this wisp's share key. Additive
/// (2026-11-09, ADR-0038).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    /// task | setup | module | crew | workflow | agent | app | plugin | doc | report | stuff
    pub kind: String,
    /// what it is here (a task id, a setup's name), so sharing it again updates the same link
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// the content (JSON), as signed
    pub body: Vec<u8>,
    /// the ed25519 public key and the signature over `body`, base64
    pub signer: String,
    pub sig: String,
    /// `{ kind: anyone|people|teams|password, people?, teams?, password? }`
    #[serde(default)]
    pub access: Option<Value>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub publish: Option<bool>,
}

/// Where a share can go (`share.destination@1`): wisp Cloud (`wisp-cloud`, from wisp.grid-client), or a
/// user's plugin's own (a company's share server). File and gist stay in the CLI and the app.
pub trait ShareDestination: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// Whether it can take a share now; the reason (and how to fix it) when it can't.
    fn ready(&self) -> wisp_kernel::BoxFuture<'static, std::result::Result<(), String>>;
    /// Uploads it: the link's view (`{ id, url, version, access, … }`).
    fn send(&self, out: Outgoing) -> wisp_kernel::BoxFuture<'static, wisp_kernel::Result<Value>>;
}

pub const DESTINATION: wisp_kernel::Point<dyn ShareDestination> = wisp_kernel::Point::new("share.destination", 1);

/// `share.send`: a task (`id`, `level`) or any other kind (`content`) to a destination.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    /// a destination's id: `wisp-cloud`
    pub to: String,
    /// task by default
    #[serde(default)]
    pub kind: Option<String>,
    /// a task: its id (the scrubbed, signed bundle of `level` goes)
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub level: Level,
    /// any other kind: what goes, as the preview showed it
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub access: Option<Value>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub publish: Option<bool>,
}

command!(SendCmd = "share.send" ["share:make"] : SendArgs => Value);
command!(Destinations = "share.destinations" ["share:make"] read yes : NoArgs => Value);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoArgs {}
