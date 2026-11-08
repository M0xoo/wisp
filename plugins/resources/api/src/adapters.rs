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
}

impl CrudKind {
    /// A kind over commands, its spec type `S` (schema, fields and defaults from it).
    pub fn new<S: schemars::JsonSchema + Default + serde::Serialize>(info: KindInfo, ctx: Ctx, list: &'static str, create: &'static str, update: &'static str, remove: &'static str) -> Self {
        let fields = props(&info.schema);
        Self { info, ctx, list: (list, json!({})), name_field: "name", id_field: "id", create, update, remove, id_arg: "id", defaults: serde_json::to_value(S::default()).unwrap_or(Value::Null), fields }
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
