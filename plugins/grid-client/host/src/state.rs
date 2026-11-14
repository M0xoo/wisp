//! What the grid client keeps (ADR-0004: one write path): one table, `grid_client_doc`, on the
//! `plugin:wisp.grid-client:account` topic.
//! - `account`: the grid signed in to, as whom, the cloud box's peer, and this computer on the grid;
//! - `import:<share id>`: a share taken in here (an import, a module source) and the version taken, so
//!   `grid-client.updates` can say "update available".
//!
//! The device token goes to secrets (`grid-client/token`), never here.
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_grid_client_api::{ComputerState, SignIn};
use wisp_kernel::{CancellationToken, Ctx, Result, WireError};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

pub const OWNER: &str = "grid-client";
pub const TOPIC: &str = "plugin:wisp.grid-client:account";
pub const TOKEN: &str = "grid-client/token";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(1, "CREATE TABLE grid_client_doc (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;")];

fn on_topic(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const DOC: EntityDef = EntityDef {
    kind: "grid_client_doc",
    table: "grid_client_doc",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: on_topic,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub grid: String,
    pub handle: String,
    /// the cloud box's peer id in machines
    #[serde(default)]
    pub machine: String,
    /// this computer on the grid, once added
    #[serde(default)]
    pub computer_id: String,
    #[serde(default)]
    pub computer_label: String,
    #[serde(default)]
    pub computer_name: String,
    #[serde(default)]
    pub computer_on: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub id: String,
    pub grid: String,
    pub url: String,
    pub title: String,
    pub kind: String,
    pub version: i64,
}

pub struct St {
    pub ctx: Ctx,
    pub store: Store,
    pub http: reqwest::Client,
    pub account: Mutex<Option<Account>>,
    pub flows: Mutex<HashMap<String, SignIn>>,
    pub computer: Mutex<ComputerState>,
    pub dialer: Mutex<Option<CancellationToken>>,
    /// the mark on requests that came through this computer's tunnel (this process only)
    pub mark: String,
}

impl std::fmt::Debug for St {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("St").finish_non_exhaustive()
    }
}

pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn hex(n: usize) -> String {
    (0..n).fold(String::with_capacity(n * 2), |mut out, _| {
        let _ = write!(out, "{:02x}", rand::random::<u8>());
        out
    })
}

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(DOC)
}

fn doc(id: &str, body: &impl Serialize) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), serde_json::to_value(body)?);
    Ok(r)
}

impl St {
    pub async fn load(ctx: Ctx, store: Store) -> Result<Arc<Self>> {
        let docs = store.read_async(|r| r.query(DOC.kind, &Query::new())).await.map_err(|e| WireError::internal(e.to_string()))?;
        let account = docs
            .iter()
            .find(|d| d.get("id").and_then(Value::as_str) == Some("account"))
            .and_then(|d| d.get("body").cloned())
            .and_then(|b| serde_json::from_value(b).ok());
        Ok(Arc::new(Self {
            ctx,
            store,
            http: crate::net::client(false),
            account: Mutex::new(account),
            flows: Mutex::new(HashMap::new()),
            computer: Mutex::new(ComputerState { state: "off".into(), ..ComputerState::default() }),
            dialer: Mutex::new(None),
            mark: hex(24),
        }))
    }

    pub fn account(&self) -> Option<Account> {
        lock(&self.account).clone()
    }

    pub async fn save_account(&self, a: Option<Account>) -> Result<()> {
        lock(&self.account).clone_from(&a);
        self.store
            .write(move |w| match &a {
                Some(a) => w.upsert(DOC.kind, doc("account", a)?).map(|_| ()),
                None => w.del(DOC.kind, "account").map(|_| ()),
            })
            .await
            .map_err(|e| WireError::internal(e.to_string()))
    }

    pub async fn token(&self) -> Option<String> {
        wisp_kernel::services::secrets(&self.ctx).ok()?.get(TOKEN).await.ok().flatten().filter(|t| !t.is_empty())
    }

    /// The account and its token, or the words to sign in.
    pub async fn signed_in(&self) -> std::result::Result<(Account, String), String> {
        let a = self.account().ok_or_else(|| "Not signed in to wisp Cloud: wisp cloud signin".to_owned())?;
        let t = self.token().await.ok_or_else(|| "Not signed in to wisp Cloud: wisp cloud signin".to_owned())?;
        Ok((a, t))
    }

    pub async fn imports(&self) -> Result<Vec<Import>> {
        let docs = self.store.read_async(|r| r.query(DOC.kind, &Query::new())).await.map_err(|e| WireError::internal(e.to_string()))?;
        Ok(docs
            .iter()
            .filter(|d| d.get("id").and_then(Value::as_str).is_some_and(|i| i.starts_with("import:")))
            .filter_map(|d| d.get("body").cloned())
            .filter_map(|b| serde_json::from_value(b).ok())
            .collect())
    }

    pub async fn save_import(&self, i: Import) -> Result<()> {
        self.store
            .write(move |w| w.upsert(DOC.kind, doc(&format!("import:{}", i.id), &i)?).map(|_| ()))
            .await
            .map_err(|e| WireError::internal(e.to_string()))
    }

    pub fn new_flow_id() -> String {
        hex(6)
    }
}
