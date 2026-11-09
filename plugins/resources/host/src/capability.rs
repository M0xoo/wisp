//! The `capability` kind (ADR-0028: "capability: kernel"): user-defined capability sets. The kernel knows
//! no kind, so wisp.resources holds it: kept as declared (`StoredKind`) and loaded into the kernel as
//! `custom:<name>` when it's applied and at start, so a caller with that set may do what it allows and
//! nothing else. Its `key` (`${secret:NAME}`) is an API key: a request with `x-wisp-key: <it>` speaks
//! with the set. It changes who may act, so it is sensitive.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::{BoxFuture, Call, CapabilitySet, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

/// A capability set: what its holder may do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilitySpec {
    /// permissions it grants (`runtime:create`, `crew:*`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// permissions it never grants, over `allow`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    /// an API key that holds it, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// the channels whose messages act with it
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<String>,
}

/// The kernel's id for a declared set.
pub fn set_id(name: &str) -> String {
    format!("custom:{name}")
}

/// The set into the kernel, and its API key (`${secret:NAME}` read; memory only) with it.
async fn load(ctx: &Ctx, name: &str, spec: &serde_json::Value) -> Result<()> {
    let c: CapabilitySpec = serde_json::from_value(spec.clone()).unwrap_or_default();
    ctx.define_capability(&CapabilitySet { id: set_id(name), allow: c.allow, deny: c.deny, ..CapabilitySet::default() })?;
    let key = match c.key.strip_prefix("${secret:").and_then(|r| r.strip_suffix('}')) {
        Some(n) => wisp_kernel::services::secrets(ctx)?.get(n).await?.unwrap_or_default(),
        None => c.key,
    };
    ctx.define_capability_key(&set_id(name), &key)
}

struct CapabilityKind(Arc<StoredKind>);

impl ResourceKind for CapabilityKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn describe(&self, op: &Op) -> Option<String> {
        let allow = op.spec.get("allow").and_then(serde_json::Value::as_array).map(|a| a.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        Some(format!("{} the capability set {} (it may: {allow})", if op.op == OpKind::Delete { "removes" } else { "sets" }, op.name))
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.0.apply(call, op).await?;
            if op.op == OpKind::Delete { self.0.ctx.remove_capability(&set_id(&op.name)) } else { load(&self.0.ctx, &op.name, &op.spec).await }
        })
    }
}

pub fn register(s: &mut Setup) {
    let inner = Arc::new(StoredKind::new(KindInfo::new("capability", "capabilities", "wisp.resources", schema_of::<CapabilitySpec>()).order(4).sensitive(), s.ctx()));
    let k: Arc<dyn ResourceKind> = Arc::new(CapabilityKind(inner.clone()));
    s.contribute(&RESOURCE_KIND, k);
    s.on_start(move |ctx| async move {
        for (name, spec) in inner.specs().await.unwrap_or_default() {
            if let Err(e) = load(&ctx, &name, &spec).await {
                tracing::warn!(set = %name, "capability set not loaded: {}", e.message);
            }
        }
        Ok(())
    });
}
