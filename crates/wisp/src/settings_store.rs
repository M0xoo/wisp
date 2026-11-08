//! The kernel's `SettingsBackend` over the store (plan §3.1 rule 8: one config system; ADR-0004: one
//! write path). Server-scoped settings are rows of `settings_value`, read once at start; a change is
//! queued as a store write (it never blocks the caller). Device settings stay on the client.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::SettingsBackend;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

const MIGRATIONS: &[Migration] = &[Migration::sql(1, "CREATE TABLE settings_value (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;")];
pub const TOPIC: &str = "config";

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

const VALUE: EntityDef = EntityDef { kind: "settings_value", table: "settings_value", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

pub struct StoreSettings {
    store: Store,
    loaded: Vec<(String, Value)>,
}

impl StoreSettings {
    /// At start (blocking is fine there): the table, and what it holds.
    pub fn open(store: &Store) -> wisp_store::Result<Arc<dyn SettingsBackend>> {
        store.migrate("settings", MIGRATIONS)?;
        store.define_entity(VALUE)?;
        let loaded = store.write_blocking(|w| {
            Ok(w.query(VALUE.kind, &Query::new())?
                .into_iter()
                .filter_map(|r| Some((r.get("id")?.as_str()?.to_owned(), r.get("body")?.get("v")?.clone())))
                .collect::<Vec<_>>())
        })?;
        Ok(Arc::new(Self { store: store.clone(), loaded }))
    }
}

impl SettingsBackend for StoreSettings {
    fn load(&self) -> Vec<(String, Value)> {
        self.loaded.clone()
    }

    fn save(&self, key: &str, value: Option<&Value>, device: bool) {
        if device {
            return;
        }
        let (key, value) = (key.to_owned(), value.cloned());
        // submitted now, in order: wisp.settings awaits a store barrier before it answers
        self.store.write_detached(move |w| match value {
            Some(v) => {
                let mut row = Row::new();
                row.insert("id".into(), json!(key));
                row.insert("body".into(), json!({ "v": v }));
                w.upsert(VALUE.kind, row).map(|_| ())
            }
            None => w.del(VALUE.kind, key).map(|_| ()),
        });
    }
}
