//! `wisp.stuff`'s commands, events and the publisher service. A command's id is also its permission
//! (`stuff.save` → `stuff:save`) unless it names another: reads share `stuff:read`, and allowing a pane
//! is `stuff:allow`, which only the user's set holds (an agent may never widen a pane's grant).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Command, Event, Result, Service};

use crate::{Grant, Published, StuffFrom, StuffItem, StuffKind, StuffView, Upload};

macro_rules! command {
    ($(#[$m:meta])* $name:ident, $id:literal, $perm:expr, $ro:expr, $args:ty => $out:ty) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = $perm;
            const READ_ONLY: bool = $ro;
            type Args = $args;
            type Out = $out;
        }
    };
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Id {
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Done {
    pub ok: bool,
}

/// `stuff.save`: exactly one of `url`, `text`, `file` (a path on this computer) or `app` (a folder);
/// with `replace` alone it edits that item's details.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SaveArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// text: its file name (notes.md); file: the name it's kept under
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// app: a picture of it (a path on this computer), for its card
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub tags: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starred: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<StuffFrom>,
    /// 'you', 'agent' or 'wisp'
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// update this item in place: the content before it stays as the one previous version
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
}

/// `stuff.update`: the fields a person (or an agent) may set on an item.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateArgs {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub tags: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FindArgs {
    #[serde(default)]
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<StuffKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// wisp_stuff's answer: the items (records, paths included) and the text the agent reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FindOut {
    pub items: Vec<StuffItem>,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Text {
    pub text: String,
}

/// `stuff.allow`: what you allow a pane, and the task it's shown on (no new scope while that task,
/// or the one that made the app, runs in Full auto).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AllowArgs {
    pub id: String,
    #[serde(default)]
    pub uses: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SetPublishedArgs {
    pub id: String,
    pub published: Option<Published>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Launched {
    pub port: u16,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ids {
    #[serde(default)]
    pub ids: Vec<String>,
}

command!(List, "stuff.list", Some("stuff:read"), true, Empty => Vec<StuffView>);
command!(
    /// One record, paths included: for agents and plugins on this computer.
    Get, "stuff.get", Some("stuff:read"), true, Id => Option<StuffItem>
);
command!(
    /// wisp_stuff's list: filtered by words and kind, with where each file is.
    Find, "stuff.find", Some("stuff:read"), true, FindArgs => FindOut
);
command!(
    /// One item in full, for an agent (@-mentions, wisp_stuff with an id).
    Describe, "stuff.describe", Some("stuff:read"), true, Id => Option<Text>
);
command!(GrantOf, "stuff.grant", Some("stuff:read"), true, Id => Grant);
command!(Save, "stuff.save", None, false, SaveArgs => StuffView);
command!(Update, "stuff.update", Some("stuff:save"), false, UpdateArgs => StuffView);
command!(Restore, "stuff.restore", Some("stuff:save"), false, Id => StuffView);
command!(Remove, "stuff.remove", Some("stuff:save"), false, Id => Done);
command!(Allow, "stuff.allow", None, false, AllowArgs => StuffView);
command!(SetPublished, "stuff.setPublished", Some("stuff:publish"), false, SetPublishedArgs => StuffView);
command!(Launch, "stuff.launch", None, false, Id => Launched);
command!(Stop, "stuff.stop", Some("stuff:launch"), false, Id => Done);
command!(ResetData, "stuff.resetData", Some("stuff:save"), false, Id => StuffView);
command!(UploadOf, "stuff.upload", Some("stuff:read"), true, Id => Option<Upload>);
command!(
    /// v1 `uploads.resolve`: unknown ids are dropped.
    Uploads, "stuff.uploads", Some("stuff:read"), true, Ids => Vec<Upload>
);
command!(RemoveUpload, "stuff.removeUpload", Some("stuff:save"), false, Id => Done);

// ---------- events (published after the command commits) ----------

/// An item was saved or updated for a task: its answer shows it as a card (v1 `savedStuff`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub by: String,
    pub kind: StuffKind,
    pub update: bool,
}
impl Event for Saved {
    const TYPE: &'static str = "stuff.saved";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Removed {
    pub id: String,
}
impl Event for Removed {
    const TYPE: &'static str = "stuff.removed";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppLaunched {
    pub id: String,
}
impl Event for AppLaunched {
    const TYPE: &'static str = "stuff.launched";
}

// ---------- the publisher (provided by the plugin that knows the grid) ----------

/// An app's public link on your wisp Grid (v1 services/publish.js). The provider writes `published`
/// with `stuff.setPublished`. Each method starts with `call.require(..)`.
pub trait Publisher: Send + Sync {
    /// where an app can go (v1 `publish.targets()`), `stuff:read`
    fn targets(&self, call: &Call) -> Result<Vec<Value>>;
    /// `stuff:publish`
    fn publish(&self, call: &Call, id: &str, opts: Value) -> BoxFuture<'static, Result<StuffItem>>;
    /// `stuff:publish`
    fn unpublish(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<StuffItem>>;
}

#[derive(Debug)]
pub struct PublishService;
impl Service for PublishService {
    const ID: &'static str = "stuff.publish";
    const MAJOR: u32 = 1;
    type Api = dyn Publisher;
}

/// What a task tells My Stuff (provided by the runtime): its title, whether it runs in Full auto,
/// and a file its reply showed or holds in its folder. `stuff:read` on the runtime's side.
pub trait TaskFiles: Send + Sync {
    fn task(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<Option<TaskInfo>>>;
    /// a file the task's reply showed or named, or one inside its folder; None when it's gone
    fn file(
        &self,
        call: &Call,
        id: &str,
        asked: &str,
    ) -> BoxFuture<'static, Result<Option<String>>>;
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    /// running in Full auto right now (v1 `runsFullAuto`)
    pub full_auto: bool,
}

#[derive(Debug)]
pub struct TaskFilesService;
impl Service for TaskFilesService {
    const ID: &'static str = "stuff.taskFiles";
    const MAJOR: u32 = 1;
    type Api = dyn TaskFiles;
}
