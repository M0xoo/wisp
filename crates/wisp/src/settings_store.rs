//! The kernel's `SettingsBackend` over the store (plan §3.1 rule 8: one config system; ADR-0004: one
//! write path). Server settings are the store's core `setting` rows on the `config` topic, the one shape
//! every client reads (`{key, value, locked_by}`): `value` is what's in force (another plugin's lock, else
//! the user's), `saved` the user's own value, read once at start. A change is queued as a store write (it
//! never blocks the caller). Device settings stay on the client.
//!
//! Before 2026-11-11 the values went to a private `settings_value` table no client read, so after a reload
//! every Settings pane showed the defaults; migration 2 moves them into `setting`.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::SettingsBackend;
use wisp_store::{Migration, Query, Row, SETTING, Store};

const MIGRATIONS: &[Migration] = &[
    Migration::sql(1, "CREATE TABLE settings_value (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;"),
    Migration::sql(
        2,
        "INSERT INTO setting (key, value, saved) SELECT id, body -> '$.v', body -> '$.v' FROM settings_value WHERE true \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, saved = excluded.saved; \
         DROP TABLE settings_value;",
    ),
];

pub struct StoreSettings {
    store: Store,
    loaded: Vec<(String, Value)>,
}

fn row(key: &str, fields: Value) -> Row {
    let mut r = Row::new();
    r.insert("key".into(), json!(key));
    if let Value::Object(m) = fields {
        r.extend(m);
    }
    r
}

/// A row's own value, `None` when it holds only a lock.
fn saved_of(r: &Row) -> Option<Value> {
    r.get("saved").filter(|v| !v.is_null()).cloned()
}

impl StoreSettings {
    /// At start (blocking is fine there): the migrations, last run's locks let go (the plugins that hold
    /// them lock again as they start), and the user's values.
    pub fn open(store: &Store) -> wisp_store::Result<Arc<dyn SettingsBackend>> {
        store.migrate("settings", MIGRATIONS)?;
        let loaded = store.write_blocking(|w| {
            let mut out = Vec::new();
            for r in w.query(SETTING.kind, &Query::new())? {
                let Some(key) = r.get("key").and_then(Value::as_str).map(str::to_owned) else { continue };
                let locked = r.get("locked_by").is_some_and(|v| !v.is_null());
                match saved_of(&r) {
                    Some(v) => {
                        if locked {
                            w.upsert(SETTING.kind, row(&key, json!({ "value": v, "locked_by": null })))?;
                        }
                        out.push((key, v));
                    }
                    None => {
                        w.del(SETTING.kind, key)?;
                    }
                }
            }
            Ok(out)
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
        // submitted now, in order: wisp.settings awaits a store barrier before it answers. A locked key is
        // never saved (the kernel refuses the write), so the row is the user's.
        self.store.write_detached(move |w| match value {
            Some(v) => w.upsert(SETTING.kind, row(&key, json!({ "value": v, "saved": v, "locked_by": null }))).map(|_| ()),
            None => w.del(SETTING.kind, key).map(|_| ()),
        });
    }

    fn lock(&self, key: &str, lock: Option<(&str, &Value)>) {
        let key = key.to_owned();
        let lock = lock.map(|(by, v)| (by.to_owned(), v.clone()));
        self.store.write_detached(move |w| match lock {
            // the pinned value is what's in force; the user's own stays in `saved`
            Some((by, v)) => w.upsert(SETTING.kind, row(&key, json!({ "value": v, "locked_by": by }))).map(|_| ()),
            None => match w.get(SETTING.kind, key.as_str())?.as_ref().and_then(saved_of) {
                Some(v) => w.upsert(SETTING.kind, row(&key, json!({ "value": v, "locked_by": null }))).map(|_| ()),
                None => w.del(SETTING.kind, key).map(|_| ()),
            },
        });
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use wisp_store::{Location, SystemClock};

    fn open(dir: &std::path::Path) -> Store {
        Store::open(Location::Path(dir.join("wisp.db")), Arc::new(SystemClock)).unwrap()
    }
    /// the queued writes are done: the writer runs them in order
    fn settle(store: &Store) {
        store.write_blocking(|_| Ok(())).unwrap();
    }
    fn setting(store: &Store, key: &str) -> Option<Row> {
        store.get(SETTING.kind, key).unwrap()
    }

    #[test]
    fn a_setting_written_reads_back_as_the_setting_row_clients_read_after_a_restart() {
        let dir: PathBuf = std::env::temp_dir().join(format!("wisp-settings-{}", wisp_kernel::ids::uuid7()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            // a wisp from before: its values in the private table no client read
            let store = open(&dir);
            store
                .migrate(
                    "settings",
                    &[Migration::sql(
                        1,
                        "CREATE TABLE settings_value (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT; \
                         INSERT INTO settings_value VALUES ('runtime.apps', '{\"v\":false}'), ('runtime.leanRuns', '{\"v\":\"all\"}');",
                    )],
                )
                .unwrap();
        }
        {
            let store = open(&dir);
            let b = StoreSettings::open(&store).unwrap();
            // moved over, as values clients read
            let mut had = b.load();
            had.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(had, vec![("runtime.apps".into(), json!(false)), ("runtime.leanRuns".into(), json!("all"))]);
            assert_eq!(setting(&store, "runtime.apps").unwrap()["value"], json!(false));
            // the user's writes, a reset, and another plugin's lock over one of them
            b.save("channels.acceptChannels", Some(&json!(true)), false);
            b.save("runtime.leanRuns", None, false);
            b.save("shell.theme", Some(&json!("dark")), true);
            b.lock("runtime.apps", Some(("wisp.policy", &json!(true))));
            settle(&store);
            let r = setting(&store, "channels.acceptChannels").unwrap();
            assert_eq!((r["value"].clone(), r["locked_by"].clone()), (json!(true), Value::Null));
            assert!(setting(&store, "runtime.leanRuns").is_none(), "a reset is the default: no row");
            assert!(setting(&store, "shell.theme").is_none(), "a device setting stays on the client");
            let r = setting(&store, "runtime.apps").unwrap();
            assert_eq!((r["value"].clone(), r["locked_by"].clone(), r["saved"].clone()), (json!(true), json!("wisp.policy"), json!(false)));
        }
        {
            // the restart: the user's values read back; last run's lock let go until its plugin locks again
            let store = open(&dir);
            let b = StoreSettings::open(&store).unwrap();
            let mut had = b.load();
            had.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(had, vec![("channels.acceptChannels".into(), json!(true)), ("runtime.apps".into(), json!(false))]);
            let r = setting(&store, "runtime.apps").unwrap();
            assert_eq!((r["value"].clone(), r["locked_by"].clone()), (json!(false), Value::Null));
            // a lock on a key at its default, then let go: no row left
            b.lock("runtime.watch", Some(("wisp.policy", &json!(false))));
            b.lock("runtime.watch", None);
            settle(&store);
            assert!(setting(&store, "runtime.watch").is_none());
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
