//! Extension points wisp.plugins owns, and the kernel service it uses.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::{BoxFuture, Call, Manifest, PluginStatus, Point, Result, Service};

use crate::Risk;

/// The type of a part prop: `int` (1–40), `px` (160–1600), `bool`, `string`, or one of a list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum PropType {
    Named(String),
    OneOf(Vec<String>),
}

/// The values a setting a plugin may set takes: one of a list, or any string (`"string"`).
pub type SettingType = PropType;

/// `plugins.vocabulary@1`: names a declarative plugin (or a v1 spell) may use, contributed by whoever
/// owns them: the shell its slots and data-parts, a settings owner the settings a plugin may set.
/// Merged over the v1 names wisp.plugins ships for the compat path. Order is kept: problems list
/// the names in it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Vocabulary {
    #[serde(default)]
    pub slots: Vec<(String, String)>,
    #[serde(default)]
    pub parts: Vec<String>,
    #[serde(default)]
    pub part_props: Vec<(String, Vec<(String, PropType)>)>,
    #[serde(default)]
    pub tokens: Vec<String>,
    #[serde(default)]
    pub icons: Vec<String>,
    #[serde(default)]
    pub settings: Vec<(String, SettingType)>,
}

/// `plugins.section@1`: a section of a spell another plugin owns and checks, such as `crew` (its
/// blueprints, wisp.crew). Without a contribution, wisp.plugins keeps the rules that make a shared
/// entry safe (crew: a name, unique keys, no folder, no machine).
pub trait Section: Send + Sync {
    fn key(&self) -> &str;
    /// entries at most
    fn max(&self) -> usize;
    /// the cleaned entries, or the problem (one line, its place in front)
    fn check(&self, entries: &[Value], at: &str) -> std::result::Result<Vec<Value>, String>;
    /// one entry in plain words, and how risky it is
    fn describe(&self, entry: &Value) -> Option<(String, Risk)>;
}

pub const VOCABULARY: Point<Vocabulary> = Point::new("plugins.vocabulary", 1);
pub const SECTION: Point<dyn Section> = Point::new("plugins.section", 1);

/// The running set of plugins, as the kernel sees it (`kernel.plugins@1`). Every result is plain data.
/// `install` registers (or replaces, same id) a user plugin from its manifest and stays off until
/// `enable`; `root` is the folder its code and relative paths resolve from (none for a converted
/// spell). Every method starts with `call.require(..)`: list and manifest `plugins:read`, install and
/// remove `plugins:install`, enable and disable `plugins:write`.
pub trait PluginHost: Send + Sync {
    fn list(&self, call: &Call) -> Result<Vec<PluginStatus>>;
    fn manifest(&self, call: &Call, id: &str) -> Result<Option<Manifest>>;
    fn install(
        &self,
        call: &Call,
        manifest: Manifest,
        root: Option<String>,
    ) -> BoxFuture<'static, Result<PluginStatus>>;
    /// refused (`conflict`) with the reason when a requirement is off or missing
    fn enable(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<PluginStatus>>;
    /// refused (`conflict`) with the dependents' names when others require it
    fn disable(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<PluginStatus>>;
    /// forgets a user plugin (switching it off first); a built-in is refused
    fn remove(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<()>>;
}

#[derive(Debug)]
pub struct PluginHostService;
impl Service for PluginHostService {
    const ID: &'static str = "kernel.plugins";
    const MAJOR: u32 = 1;
    type Api = dyn PluginHost;
}
