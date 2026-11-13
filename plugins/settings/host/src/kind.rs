//! The `setting` resource kind (ADR-0026): every setting a user set, by key, in a formula's `settings:`
//! map. Keys a plugin declares as part of its own kind (`claims_settings`, such as `budget:`) are left
//! to that kind; device settings belong to `ui`, secrets never go in a formula.

use serde_json::{Map, Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, SettingInfo};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind};

#[derive(Debug)]
pub struct SettingKind {
    pub ctx: Ctx,
}

fn schema_of(s: &SettingInfo) -> Value {
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
    p["description"] = json!(d.title.clone().unwrap_or_else(|| format!("{} ({})", s.key, s.owner)));
    p
}

impl SettingKind {
    /// The settings this kind declares: server-scoped, not secret, not part of another kind.
    fn mine(&self) -> Vec<SettingInfo> {
        let claimed: Vec<String> = self.ctx.contributions(&RESOURCE_KIND).iter().filter_map(|k| k.claims_settings()).collect();
        self.ctx
            .settings_list()
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.scope != "device" && !s.decl.secret && !claimed.contains(&s.owner))
            .collect()
    }
}

impl ResourceKind for SettingKind {
    fn info(&self) -> KindInfo {
        let props: Map<String, Value> = self.mine().iter().map(|s| (s.key.clone(), schema_of(s))).collect();
        let schema = json!({ "type": "object", "description": "Settings by key (wisp settings list)", "properties": props, "additionalProperties": false });
        KindInfo::new("setting", "settings", wisp_settings_api::PLUGIN_ID, schema).map_form().order(5)
    }

    fn read<'a>(&'a self, _call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        Box::pin(async move {
            Ok(self
                .mine()
                .into_iter()
                .filter(|s| s.locked_by.is_none())
                .filter_map(|s| {
                    let v = s.value.clone()?;
                    (s.decl.default.as_ref() != Some(&v)).then(|| Resource::new("setting", s.key, v))
                })
                .collect())
        })
    }

    fn check(&self, r: &Resource) -> Vec<String> {
        let key = wisp_settings_api::key_of(&r.name);
        let Some(s) = self.ctx.settings_list().unwrap_or_default().into_iter().find(|s| s.key == key) else {
            return vec![format!("no setting named {key} (wisp settings list)")];
        };
        let mut out = Vec::new();
        if s.scope == "device" {
            out.push(format!("{key} is this device's: it goes under ui:"));
        }
        if let Some(by) = &s.locked_by {
            out.push(format!("{key} is set by {by}"));
        }
        let ok = match s.decl.ty.as_str() {
            "int" => r.spec.as_i64().is_some(),
            "bool" => r.spec.is_boolean(),
            "string" => r.spec.is_string(),
            "enum" => r.spec.as_str().is_some_and(|v| s.decl.values.as_ref().is_none_or(|vs| vs.iter().any(|x| x == v))),
            _ => true,
        };
        if !ok && !r.spec.is_null() {
            out.push(format!(
                "{key} is {}{}, not {}",
                s.decl.ty,
                s.decl.values.as_ref().map(|v| format!(" ({})", v.join(", "))).unwrap_or_default(),
                r.spec
            ));
        }
        out
    }

    fn apply<'a>(&'a self, _call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let key = wisp_settings_api::key_of(&op.name).to_owned();
            let v = (op.op != OpKind::Delete && !op.spec.is_null()).then(|| op.spec.clone());
            self.ctx.set_setting(&key, v)?;
            crate::durable(&self.ctx).await;
            Ok(())
        })
    }
}
