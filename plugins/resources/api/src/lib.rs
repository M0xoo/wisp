//! wisp-resources-api: wisp as code (ADR-0026, ADR-0028). Everything a user sets up is a *resource*:
//! a kind, a stable name and a typed spec. Each plugin owns its kinds through one point,
//! `resource.kind@1`; the kernel knows none. `wisp.resources` plans, applies and exports over all of them.
//!
//! A kind gives:
//! - its schema (JSON Schema generated from the Rust spec type and its doc comments: [`schema_of`]);
//! - `read`: the current state, as specs;
//! - optionally its own `plan`; otherwise the generic one (wisp-resources-core) applies: a desired spec
//!   is a patch over the current one, so the fields a formula leaves out keep their value;
//! - `apply(op)`: through the owner's own commands, so permissions, events and the change feed work as
//!   for a click in Settings.

mod adapters;

pub use adapters::{CrudKind, SettingsKind, StoredKind, stored};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Command, Point, Result};

pub use schemars;

pub const PLUGIN_ID: &str = "wisp.resources";
/// The formula format this build reads and writes (`wisp: 1`).
pub const FORMAT: u32 = 1;

/// One declared thing: `crew/Ada`, `setting/worktrees.max`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resource {
    pub kind: String,
    pub name: String,
    /// the spec as the kind's schema describes it (secrets as `${secret:NAME}` references)
    #[serde(default)]
    pub spec: Value,
    /// the owner's own id for it, when that isn't its name (read only; never exported)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl Resource {
    pub fn new(kind: impl Into<String>, name: impl Into<String>, spec: Value) -> Self {
        Self { kind: kind.into(), name: name.into(), spec, id: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Create,
    Update,
    Delete,
}

/// One field a plan changes (`model`: `sonnet` → `opus`); a path into the spec, `/`-separated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldChange {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub op: OpKind,
    pub kind: String,
    pub name: String,
    /// the whole spec after the op (create, update), or the one that goes (delete)
    pub spec: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<FieldChange>,
    /// an update's spec before it: what a rollback puts back
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
}

/// Who a kind's resources belong to: exports leave out `personal` and `device` ones unless asked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Shared,
    /// yours (harness accounts): `--include account`
    Personal,
    /// this device's (theme, layout): `--include ui`
    Device,
}

/// What a kind is, for the engine, the CLI and Settings → Import.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(clippy::struct_excessive_bools)] // each is a fact a formula's reader needs about the kind
pub struct KindInfo {
    /// `crew`, `setting`
    pub kind: String,
    /// its section in a formula (`crew:`, `agents:`, `settings:`)
    pub section: String,
    /// the plugin that owns it
    pub owner: String,
    #[serde(default)]
    pub scope: Scope,
    /// it changes who may act (capability, channel, machine, trigger): a foreign formula needs `--trust`
    #[serde(default)]
    pub sensitive: bool,
    /// applied in this order (lower first; deletes go in reverse)
    #[serde(default)]
    pub order: i32,
    /// the section is a map of name → value (`settings: { worktrees.max: 4 }`), not a list of named specs
    #[serde(default)]
    pub map_form: bool,
    /// the section is one object, the kind's one resource (`budget: { stopAt: 75 }`), named `default`
    #[serde(default)]
    pub singleton: bool,
    /// its specs are some of the owner's settings: the generic `setting` kind leaves those keys to it
    #[serde(default)]
    pub claims_settings: bool,
    /// other section names a formula may use for it (`recipes:` for `tasks:`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// JSON Schema of one spec
    pub schema: Value,
    /// one line for `wisp schema` and Settings → Import
    #[serde(default)]
    pub doc: String,
}

impl KindInfo {
    pub fn new(kind: &str, section: &str, owner: &str, schema: Value) -> Self {
        let doc = schema.get("description").and_then(Value::as_str).unwrap_or_default().to_owned();
        Self { kind: kind.into(), section: section.into(), owner: owner.into(), scope: Scope::Shared, sensitive: false, order: 100, map_form: false, singleton: false, claims_settings: false, aliases: Vec::new(), schema, doc }
    }
    #[must_use]
    pub fn order(mut self, n: i32) -> Self {
        self.order = n;
        self
    }
    #[must_use]
    pub fn scope(mut self, s: Scope) -> Self {
        self.scope = s;
        self
    }
    #[must_use]
    pub fn sensitive(mut self) -> Self {
        self.sensitive = true;
        self
    }
    #[must_use]
    pub fn map_form(mut self) -> Self {
        self.map_form = true;
        self
    }
    #[must_use]
    pub fn alias(mut self, section: &str) -> Self {
        self.aliases.push(section.to_owned());
        self
    }
    /// whether `name` is this kind's kind, section or an alias
    pub fn named(&self, name: &str) -> bool {
        self.kind == name || self.section == name || self.aliases.iter().any(|a| a == name)
    }
    #[must_use]
    pub fn singleton(mut self) -> Self {
        self.singleton = true;
        self
    }
}

/// The JSON Schema of `T`, from its Rust type and doc comments.
pub fn schema_of<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or(Value::Null)
}

/// A resource kind (`resource.kind@1`). The owner keeps its `Ctx` to run its own commands.
pub trait ResourceKind: Send + Sync {
    fn info(&self) -> KindInfo;
    /// The current state, one resource per thing, as specs.
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>>;
    /// The kind's own plan; None: the generic one (a desired spec patches the current one).
    fn plan(&self, _current: &[Resource], _desired: &[Resource], _prune: bool) -> Option<Vec<Op>> {
        None
    }
    /// The plugin whose settings this kind declares (the generic `setting` kind leaves them out). Cheap:
    /// it is asked while another kind builds its own info.
    fn claims_settings(&self) -> Option<String> {
        None
    }
    /// A desired spec in the form `read` gives (`every day at 2` → `0 2 * * *`), so an unchanged thing
    /// plans as unchanged.
    fn normalize(&self, _spec: &mut Value) {}
    /// Problems beyond the schema (a project's path that isn't absolute, a cron that doesn't parse).
    fn check(&self, _r: &Resource) -> Vec<String> {
        Vec::new()
    }
    /// The op in plain words, for the trust prompt ("lets Telegram chat 123 start tasks").
    fn describe(&self, _op: &Op) -> Option<String> {
        None
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>>;
}

pub const RESOURCE_KIND: Point<dyn ResourceKind> = Point::new("resource.kind", 1);

/// What `apply` would do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub ops: Vec<Op>,
    /// resources the formula declares that are already so
    pub unchanged: usize,
    /// `${secret:NAME}` references with no secret of that name here
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_secrets: Vec<String>,
    /// ops on kinds that change who may act, in plain words (a foreign formula needs `--trust`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sensitive: Vec<String>,
    /// schema and kind problems: apply refuses while there are any
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub problems: Vec<String>,
}

/// `resources.plan` / `resources.apply`: resources already read from a formula (the CLI does the
/// files, includes, profiles and `${env:…}`; secrets stay references).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlanArgs {
    pub resources: Vec<Resource>,
    /// also delete what the formula doesn't declare, in the kinds it mentions
    #[serde(default)]
    pub prune: bool,
    /// the formula came from somewhere else (a URL, a gist, a teammate)
    #[serde(default)]
    pub foreign: bool,
    /// the user said yes to its sensitive ops (`--trust`)
    #[serde(default)]
    pub trust: bool,
    /// `kind.name` addresses to delete (`wisp destroy`), whatever `resources` says. Additive (2026-11-09).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub destroy: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Applied {
    pub plan: Plan,
    pub applied: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ExportArgs {
    /// only these kinds (or sections); empty: every shared kind
    #[serde(default)]
    pub kinds: Vec<String>,
    /// personal and device kinds to add (`account`, `ui`)
    #[serde(default)]
    pub include: Vec<String>,
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

command!(Kinds = "resources.kinds" ["resources:read"] read yes : Value => Vec<KindInfo>);
command!(PlanCmd = "resources.plan" ["resources:read"] read yes : PlanArgs => Plan);
command!(Apply = "resources.apply" ["resources:apply"] : PlanArgs => Applied);
command!(Export = "resources.export" ["resources:read"] read yes : ExportArgs => Vec<Resource>);
