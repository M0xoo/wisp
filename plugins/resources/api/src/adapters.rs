//! Two shapes most kinds have, so an owner contributes its kind in a few lines:
//!
//! - [`CrudKind`]: rows behind a list command and create / update / remove commands (crew members,
//!   connectors, recipes, triggers). The spec's fields are the schema's properties; a field at the spec
//!   type's default is left out, so exports stay short and still round-trip.
//! - [`SettingsKind`]: some of the owner's settings as one object (`budget: { stopAt: 75 }`), written
//!   through the settings registry (`Ctx::set_setting`).
//!
//! Both run as the owner (its `Ctx`), so its permissions, events and change feed apply.

use serde_json::{Map, Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, WireError};

use crate::{KindInfo, Op, OpKind, Resource, ResourceKind};

/// The fields `schema` declares, in order.
fn props(schema: &Value) -> Vec<String> {
    schema.get("properties").and_then(Value::as_object).map(|p| p.keys().cloned().collect()).unwrap_or_default()
}

/// Nothing to declare: null, '', [], {} or false.
fn empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::Number(_) => false,
    }
}

/// `row`'s spec fields, those at their default (or empty) left out.
fn spec_of(row: &Value, fields: &[String], defaults: &Value) -> Value {
    let mut o = Map::new();
    for f in fields {
        if let Some(v) = row.get(f)
            && !empty(v)
            && defaults.get(f) != Some(v)
        {
            o.insert(f.clone(), v.clone());
        }
    }
    Value::Object(o)
}

/// Rows behind commands.
pub struct CrudKind {
    pub info: KindInfo,
    pub ctx: Ctx,
    /// the list command and its args
    pub list: (&'static str, Value),
    /// the row field that is the resource's name (`name`), and the one that is its id (`id`)
    pub name_field: &'static str,
    pub id_field: &'static str,
    pub create: &'static str,
    pub update: &'static str,
    pub remove: &'static str,
    /// the arg the id goes in on update and remove (`id`, `key`)
    pub id_arg: &'static str,
    /// the spec type's default, as JSON
    pub defaults: Value,
    fields: Vec<String>,
    /// the command that renames in place (`{from, to}`); None: the trait's make-then-remove
    pub rename_cmd: Option<&'static str>,
}

impl CrudKind {
    /// A kind over commands, its spec type `S` (schema, fields and defaults from it).
    pub fn new<S: schemars::JsonSchema + Default + serde::Serialize>(info: KindInfo, ctx: Ctx, list: &'static str, create: &'static str, update: &'static str, remove: &'static str) -> Self {
        let fields = props(&info.schema);
        Self { info, ctx, list: (list, json!({})), name_field: "name", id_field: "id", create, update, remove, id_arg: "id", defaults: serde_json::to_value(S::default()).unwrap_or(Value::Null), fields, rename_cmd: None }
    }
    /// Renames go through `cmd` (`{from, to}`, one write in the owner), not make-then-remove.
    #[must_use]
    pub fn renames(mut self, cmd: &'static str) -> Self {
        self.rename_cmd = Some(cmd);
        self
    }
    #[must_use]
    pub fn keyed(mut self, name_field: &'static str, id_field: &'static str, id_arg: &'static str) -> Self {
        self.name_field = name_field;
        self.id_field = id_field;
        self.id_arg = id_arg;
        self
    }
    #[must_use]
    pub fn list_args(mut self, args: Value) -> Self {
        self.list.1 = args;
        self
    }
}

impl std::fmt::Debug for CrudKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CrudKind").field("kind", &self.info.kind).finish_non_exhaustive()
    }
}

impl ResourceKind for CrudKind {
    fn info(&self) -> KindInfo {
        self.info.clone()
    }
    fn rename<'a>(&'a self, call: &'a Call, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if let Some(cmd) = self.rename_cmd {
                return self.ctx.run_json(call, cmd, json!({ "from": from, "to": to })).await.map(drop);
            }
            let now = self.read(call).await?;
            let r = now.iter().find(|r| r.name == from).ok_or_else(|| WireError::not_found(format!("wisp has no {} named {from}", self.info.kind)))?;
            self.apply(call, &Op { op: OpKind::Create, kind: self.info.kind.clone(), name: to.to_owned(), spec: r.spec.clone(), id: None, changes: Vec::new(), before: None }).await?;
            self.apply(call, &Op { op: OpKind::Delete, kind: self.info.kind.clone(), name: from.to_owned(), spec: r.spec.clone(), id: r.id.clone(), changes: Vec::new(), before: None }).await
        })
    }

    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        Box::pin(async move {
            let rows = self.ctx.run_json(call, self.list.0, self.list.1.clone()).await?;
            let rows = rows.as_array().cloned().unwrap_or_default();
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name = r.get(self.name_field)?.as_str()?.to_owned();
                    let id = r.get(self.id_field).and_then(|i| i.as_str().map(str::to_owned).or_else(|| Some(i.to_string())));
                    Some(Resource { kind: self.info.kind.clone(), name, spec: spec_of(r, &self.fields, &self.defaults), id })
                })
                .collect())
        })
    }

    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut args = op.spec.as_object().cloned().unwrap_or_default();
            let id = op.id.clone().unwrap_or_else(|| op.name.clone());
            let (cmd, args) = match op.op {
                OpKind::Create => {
                    args.insert(self.name_field.to_owned(), Value::String(op.name.clone()));
                    (self.create, Value::Object(args))
                }
                OpKind::Update => {
                    // a field the formula cleared goes back to its default
                    for c in &op.changes {
                        if c.to.is_none() && !c.path.contains('/') {
                            args.insert(c.path.clone(), self.defaults.get(&c.path).cloned().unwrap_or(Value::Null));
                        }
                    }
                    args.insert(self.id_arg.to_owned(), Value::String(id));
                    (self.update, Value::Object(args))
                }
                OpKind::Delete => (self.remove, json!({ self.id_arg: id })),
            };
            self.ctx.run_json(call, cmd, args).await.map(|_| ())
        })
    }
}

/// Some of the owner's settings as the kind's one resource (`default`). The fields are the keys
/// without the owner's prefix (`budget.stopAt` → `stopAt`); a value at its default is left out. The
/// schema comes from the settings' declarations, read when asked (every plugin's are known by then).
pub struct SettingsKind {
    pub kind: &'static str,
    pub section: &'static str,
    pub ctx: Ctx,
    /// the keys' prefix (`budget.`)
    pub prefix: &'static str,
}

impl std::fmt::Debug for SettingsKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsKind").field("kind", &self.kind).finish_non_exhaustive()
    }
}

impl SettingsKind {
    fn mine(&self) -> Vec<wisp_kernel::SettingInfo> {
        self.ctx.settings_list().unwrap_or_default().into_iter().filter(|s| s.owner == self.ctx.plugin() && s.key.starts_with(self.prefix) && s.scope != "device" && !s.decl.secret).collect()
    }
}

impl ResourceKind for SettingsKind {
    fn info(&self) -> KindInfo {
        let mut props = Map::new();
        for s in self.mine() {
            let d = &s.decl;
            let mut p = match d.ty.as_str() {
                "int" => json!({ "type": "integer" }),
                "bool" => json!({ "type": "boolean" }),
                "enum" => json!({ "type": "string", "enum": d.values.clone().unwrap_or_default() }),
                "string" => json!({ "type": "string" }),
                _ => json!({}),
            };
            if let Some(m) = d.min {
                p["minimum"] = json!(m);
            }
            if let Some(m) = d.max {
                p["maximum"] = json!(m);
            }
            if let Some(t) = &d.title {
                p["description"] = json!(t);
            }
            props.insert(s.key[self.prefix.len()..].to_owned(), p);
        }
        let schema = json!({ "type": "object", "description": format!("{}'s settings", self.ctx.plugin()), "properties": Value::Object(props), "additionalProperties": false });
        let mut info = KindInfo::new(self.kind, self.section, self.ctx.plugin(), schema).singleton();
        info.claims_settings = true;
        info
    }

    fn claims_settings(&self) -> Option<String> {
        Some(self.ctx.plugin().to_owned())
    }

    fn read<'a>(&'a self, _call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        Box::pin(async move {
            let mut o = Map::new();
            for s in self.mine() {
                if let Some(v) = s.value.filter(|v| s.decl.default.as_ref() != Some(v)) {
                    o.insert(s.key[self.prefix.len()..].to_owned(), v);
                }
            }
            Ok(if o.is_empty() { Vec::new() } else { vec![Resource::new(self.kind, "default", Value::Object(o))] })
        })
    }

    fn apply<'a>(&'a self, _call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let set = |k: &str, v: Option<Value>| self.ctx.set_setting(&format!("{}{k}", self.prefix), v);
            if op.op == OpKind::Delete {
                for k in op.spec.as_object().into_iter().flat_map(|o| o.keys()) {
                    set(k, None)?;
                }
            } else {
                let Some(o) = op.spec.as_object() else { return Err(WireError::invalid(format!("{} is an object", self.section))) };
                for (k, v) in o {
                    set(k, if v.is_null() { None } else { Some(v.clone()) })?;
                }
                for c in op.changes.iter().filter(|c| c.to.is_none()) {
                    set(&c.path, None)?;
                }
            }
            Ok(())
        })
    }
}

/// Specs a plugin keeps as they were declared, in its own table (`<plugin>_spec_<kind>`, migrated under
/// `<plugin>.spec.<kind>`): for configuration that has no rows of its own yet. The owner reads them back
/// with [`StoredKind::specs`] where it acts on them.
pub struct StoredKind {
    pub info: KindInfo,
    pub ctx: Ctx,
    def: wisp_store::EntityDef,
    owner: &'static str,
    sql: &'static str,
    ready: std::sync::OnceLock<()>,
    /// the owner's normalisation of a spec before it's stored (a project's path made canonical). Additive (2026-11-12).
    tidy: Option<fn(&mut Value)>,
}

impl std::fmt::Debug for StoredKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredKind").field("kind", &self.info.kind).finish_non_exhaustive()
    }
}

fn stored_topics(_: &wisp_store::Row) -> Vec<String> {
    vec!["plugin:wisp.resources:specs".into()]
}

fn config_topics(_: &wisp_store::Row) -> Vec<String> {
    vec!["config".into()]
}

#[allow(clippy::needless_pass_by_value)] // for map_err
fn store_err(e: wisp_store::StoreError) -> WireError {
    WireError::internal(format!("store: {e}"))
}

/// A `&'static str` made once per kind at startup (the store's entity definitions are static).
fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

impl StoredKind {
    /// The kind `info` for `ctx`'s plugin, kept in its own table.
    pub fn new(info: KindInfo, ctx: Ctx) -> Self {
        let prefix = ctx.plugin().rsplit('.').next().unwrap_or("plugin").replace('-', "_");
        let table = leak(format!("{prefix}_spec_{}", info.kind.replace('-', "_")));
        let def = wisp_store::EntityDef { kind: table, table, key: "id", columns: &[("id", wisp_store::Col::Text), ("body", wisp_store::Col::Text)], json_columns: &["body"], parent: None, seq: None, topics: stored_topics };
        Self { owner: leak(format!("{prefix}.spec.{}", info.kind)), sql: leak(format!("CREATE TABLE {table} (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;")), def, info, ctx, ready: std::sync::OnceLock::new(), tidy: None }
    }

    /// Its rows reach every client as entity `entity` on `config` (a row is `{id: name, body: spec}`), the topic
    /// every screen watches and reads in full (`wisp serve` lists `entity` among config's sources): for a kind
    /// the app shows everywhere, such as projects.
    #[must_use]
    pub fn published(mut self, entity: &'static str) -> Self {
        self.def.kind = entity;
        self.def.topics = config_topics;
        self
    }

    /// Every spec applied goes through `f` first (the owner's normalisation: a canonical path, a trimmed name).
    #[must_use]
    pub fn tidied(mut self, f: fn(&mut Value)) -> Self {
        self.tidy = Some(f);
        self
    }

    /// Defines its table and entity now (at start), so the first read of `config` finds it.
    pub fn ensure(&self) -> Result<()> {
        self.store().map(drop)
    }

    fn store(&self) -> Result<std::sync::Arc<wisp_store::Store>> {
        let store = self.ctx.service::<wisp_store::Store>()?;
        if self.ready.get().is_none() {
            let m = [wisp_store::Migration::sql(1, self.sql)];
            store.migrate(self.owner, &m).map_err(store_err)?;
            store.define_entity(self.def).map_err(store_err)?;
            let _ = self.ready.set(());
        }
        Ok(store)
    }

    /// Every stored spec, by name.
    pub async fn specs(&self) -> Result<Vec<(String, Value)>> {
        let store = self.store()?;
        let kind = self.def.kind;
        let rows = store.read_async(move |r| r.query(kind, &wisp_store::Query::new())).await.map_err(store_err)?;
        let mut out: Vec<(String, Value)> = rows.into_iter().filter_map(|r| Some((r.get("id")?.as_str()?.to_owned(), r.get("body")?.clone()))).collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }
}

impl ResourceKind for StoredKind {
    fn info(&self) -> KindInfo {
        self.info.clone()
    }

    fn read<'a>(&'a self, _call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        Box::pin(async move { Ok(self.specs().await?.into_iter().map(|(n, s)| Resource::new(self.info.kind.clone(), n, s)).collect()) })
    }

    /// In place: one write moves the row to its new name.
    fn rename<'a>(&'a self, _call: &'a Call, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let store = self.store()?;
            let (kind, from, to) = (self.def.kind, from.to_owned(), to.to_owned());
            store
                .write(move |w| {
                    let Some(row) = w.get(kind, from.as_str())? else { return Ok(false) };
                    let mut r = row.clone();
                    r.insert("id".into(), Value::String(to));
                    w.upsert(kind, r)?;
                    w.del(kind, from.as_str())?;
                    Ok(true)
                })
                .await
                .map_err(store_err)?
                .then_some(())
                .ok_or_else(|| WireError::not_found(format!("wisp has no {} to rename", self.info.kind)))
        })
    }

    fn apply<'a>(&'a self, _call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let store = self.store()?;
            let (kind, name, mut spec, del) = (self.def.kind, op.name.clone(), op.spec.clone(), op.op == OpKind::Delete);
            if let Some(f) = self.tidy {
                f(&mut spec);
            }
            store
                .write(move |w| {
                    if del {
                        return w.del(kind, name.as_str()).map(|_| ());
                    }
                    let mut r = wisp_store::Row::new();
                    r.insert("id".into(), Value::String(name));
                    r.insert("body".into(), spec);
                    w.upsert(kind, r).map(|_| ())
                })
                .await
                .map_err(store_err)
        })
    }
}

/// Contributes a [`StoredKind`] for spec type `S` and hands it back, for the owner to read its specs.
/// [`stored`], its rows published as entity `entity` on `config` ([`StoredKind::published`]), defined at start.
pub fn stored_published<S: schemars::JsonSchema>(s: &mut wisp_kernel::Setup, entity: &'static str, info: impl FnOnce(Value) -> KindInfo) -> std::sync::Arc<StoredKind> {
    let k = std::sync::Arc::new(StoredKind::new(info(crate::schema_of::<S>()), s.ctx()).published(entity));
    let as_kind: std::sync::Arc<dyn ResourceKind> = k.clone();
    s.contribute(&crate::RESOURCE_KIND, as_kind);
    let start = k.clone();
    s.on_start(move |_| async move { start.ensure() });
    k
}

/// [`stored_published`], each spec tidied by `tidy` before it's stored ([`StoredKind::tidied`]).
pub fn stored_published_tidied<S: schemars::JsonSchema>(s: &mut wisp_kernel::Setup, entity: &'static str, info: impl FnOnce(Value) -> KindInfo, tidy: fn(&mut Value)) -> std::sync::Arc<StoredKind> {
    let k = std::sync::Arc::new(StoredKind::new(info(crate::schema_of::<S>()), s.ctx()).published(entity).tidied(tidy));
    let as_kind: std::sync::Arc<dyn ResourceKind> = k.clone();
    s.contribute(&crate::RESOURCE_KIND, as_kind);
    let start = k.clone();
    s.on_start(move |_| async move { start.ensure() });
    k
}

pub fn stored<S: schemars::JsonSchema>(s: &mut wisp_kernel::Setup, info: impl FnOnce(Value) -> KindInfo) -> std::sync::Arc<StoredKind> {
    let k = std::sync::Arc::new(StoredKind::new(info(crate::schema_of::<S>()), s.ctx()));
    let as_kind: std::sync::Arc<dyn ResourceKind> = k.clone();
    s.contribute(&crate::RESOURCE_KIND, as_kind);
    k
}
