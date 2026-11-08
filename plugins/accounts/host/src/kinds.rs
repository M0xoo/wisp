//! wisp.accounts' resource kind (ADR-0028): harness accounts by reference (`<harness>/<id>`), never a
//! token. Personal: left out of exports unless `--include account`. Read and written through the
//! accounts' own commands, so a declared account is the one Settings shows.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup, WireError};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, Scope, schema_of};

/// A harness account (its sign-in stays in the harness's own folder).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountSpec {
    /// what it shows as
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// personal | work
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

struct AccountKind {
    ctx: Ctx,
}

fn split(name: &str) -> Result<(&str, &str)> {
    name.split_once('/').ok_or_else(|| WireError::invalid(format!("an account is <harness>/<id> (not {name})")))
}

impl ResourceKind for AccountKind {
    fn info(&self) -> KindInfo {
        KindInfo::new("account", "accounts", "wisp.accounts", schema_of::<AccountSpec>()).scope(Scope::Personal).order(14)
    }

    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        Box::pin(async move {
            let all = self.ctx.run_json(call, "accounts.harnesses", Value::Null).await?;
            let mut out = Vec::new();
            for h in all.as_array().into_iter().flatten() {
                let agent = h.get("agent").and_then(Value::as_str).unwrap_or_default();
                for a in h.get("accounts").and_then(Value::as_array).into_iter().flatten() {
                    // the harness's own folder is there by itself: not something to declare
                    if a.get("default") == Some(&json!(true)) {
                        continue;
                    }
                    let id = a.get("id").and_then(Value::as_str).unwrap_or_default();
                    let mut spec = serde_json::Map::new();
                    for k in ["label", "kind"] {
                        if let Some(v) = a.get(k).and_then(Value::as_str).filter(|v| !v.is_empty() && (k != "kind" || *v != "personal")) {
                            spec.insert(k.into(), json!(v));
                        }
                    }
                    out.push(Resource { id: Some(id.to_owned()), ..Resource::new("account", format!("{agent}/{id}"), Value::Object(spec)) });
                }
            }
            Ok(out)
        })
    }

    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let (agent, id) = split(&op.name)?;
            let s = |k: &str| op.spec.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            let (cmd, args) = match op.op {
                OpKind::Create => ("accounts.add", json!({ "agent": agent, "id": id, "label": s("label"), "kind": s("kind") })),
                OpKind::Update => ("accounts.update", json!({ "agent": agent, "account": id, "label": s("label"), "kind": if s("kind").is_empty() { "personal".to_owned() } else { s("kind") } })),
                OpKind::Delete => ("accounts.remove", json!({ "agent": agent, "account": id })),
            };
            self.ctx.run_json(call, cmd, args).await.map(|_| ())
        })
    }
}

pub fn register(s: &mut Setup) {
    let k: std::sync::Arc<dyn ResourceKind> = std::sync::Arc::new(AccountKind { ctx: s.ctx() });
    s.contribute(&RESOURCE_KIND, k);
}
