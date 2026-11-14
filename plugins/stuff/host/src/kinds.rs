//! wisp.stuff's resource kinds (ADR-0028): My Stuff's apps and panes with their source, data schema and
//! grants. Acted on: applying one puts it on the shelf (a starter added, a folder or inline code saved
//! as an app, its grants allowed), keyed `resource:<kind>:<name>` so applying again updates the same
//! item; `enabled: false` or removing it takes it off. What an app keeps (its data) stays data.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Result, Setup, WireError};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};
use wisp_stuff_api::{StuffFrom, StuffItem};

use crate::save::SaveOpts;
use crate::state::{self, Cell, Stuff};

/// An app or a pane: where its code comes from and what it may do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSpec {
    /// a folder, or `starter:<name>` for one wisp ships
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// its code inline (a single-file app)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub inline: String,
    /// its data's shape (JSON Schema)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// what it may call (commands, topics)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<String>,
    /// off: kept but not shown
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

fn key(kind: &str, name: &str) -> String {
    format!("resource:{kind}:{name}")
}

fn wire(e: crate::error::Error) -> WireError {
    e.into()
}

/// The item this resource is on the shelf, if it's there.
fn placed(s: &Stuff, kind: &str, name: &str, spec: &AppSpec) -> Option<StuffItem> {
    let starter = spec.source.strip_prefix("starter:").map(|id| format!("starter:{id}"));
    s.shelf.find_key(Some(&key(kind, name))).or_else(|| starter.and_then(|k| s.shelf.find_key(Some(&k))))
}

async fn put(s: &Stuff, kind: &str, name: &str, spec: &AppSpec) -> Result<()> {
    let was = s.shelf.find_key(Some(&key(kind, name)));
    let o = || SaveOpts {
        by: Some("wisp.yml".into()),
        from: Some(StuffFrom { key: Some(key(kind, name)), title: Some(name.to_owned()), ..StuffFrom::default() }),
        replace: was.as_ref().map(|w| w.id.clone()),
        fields: wisp_stuff_core::record::Fields { title: Some(name.to_owned()), ..Default::default() },
        ..SaveOpts::default()
    };
    let it = if let Some(id) = spec.source.strip_prefix("starter:") {
        crate::starters::add(&s.shelf, id).await.map_err(wire)?.ok_or_else(|| WireError::invalid(format!("wisp has no starter {id}")))?.0
    } else if !spec.inline.is_empty() {
        let dir = std::env::temp_dir().join(format!("wisp-app-{}", wisp_kernel::ids::uuid7()));
        let folder = dir.join(name);
        tokio::fs::create_dir_all(&folder).await.map_err(|e| WireError::internal(e.to_string()))?;
        tokio::fs::write(folder.join("index.html"), &spec.inline).await.map_err(|e| WireError::internal(e.to_string()))?;
        let r = s.shelf.save_app(&folder, None, o()).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        r.map_err(wire)?
    } else if !spec.source.is_empty() {
        s.shelf.save_app(std::path::Path::new(&spec.source), None, o()).await.map_err(wire)?
    } else {
        return Err(WireError::invalid(format!("{kind} {name} needs a source (a folder or starter:<name>) or inline code")));
    };
    if !spec.grants.is_empty() {
        s.shelf.allow(&it.id, &spec.grants).await.map_err(wire)?;
    }
    Ok(())
}

struct AppKind {
    inner: Arc<StoredKind>,
    cell: Cell,
}

impl ResourceKind for AppKind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let s = state::get(&self.cell)?;
            let kind = self.inner.info.kind.clone();
            let spec: AppSpec = serde_json::from_value(op.spec.clone()).unwrap_or_default();
            if op.op == OpKind::Delete || spec.enabled == Some(false) {
                if let Some(it) = placed(&s, &kind, &op.name, &spec) {
                    s.shelf.remove(&it.id).await.map_err(wire)?;
                }
            } else {
                put(&s, &kind, &op.name, &spec).await?;
            }
            self.inner.apply(call, op).await
        })
    }
}

pub fn register(s: &mut Setup, cell: &Cell) {
    for (kind, section, order) in [("app", "apps", 70), ("pane", "panes", 71)] {
        let inner = Arc::new(StoredKind::new(KindInfo::new(kind, section, "wisp.stuff", schema_of::<AppSpec>()).order(order), s.ctx()));
        let k: Arc<dyn ResourceKind> = Arc::new(AppKind { inner, cell: cell.clone() });
        s.contribute(&RESOURCE_KIND, k);
    }
}
