//! What the hub keeps across a restart (ADR-0004: the plugin owns its tables, one write path through the store).
//! `chan_task`: where each channel task came from (its `remote`: the thread, chat and message ids each transport
//! keeps; the channel it started on and who; its away entry), so its report still goes back after a restart.
//! `chan_kept`: what each transport keeps for itself (`set_cfg`: Telegram's link, poll offset and webhook), never
//! a declared field (the `channel` resource has those) and never a secret one (`TransportDef::secrets`, such as
//! Telegram's `hook.secret`): those go to secrets.json under `channels/kept/<transport>/<path>`. A transport's
//! kept state is tied to its token: a new token starts it over, as `kinds::keep_over` does in memory.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use wisp_channels_api::AwayEntry;
use wisp_channels_api::views::Remote;
use wisp_kernel::Ctx;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

use crate::hub::State;
use crate::lock;

pub const OWNER: &str = "channels";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE chan_task (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE chan_kept (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

/// No client reads these rows (chat ids, threads); the store wants each on a topic, so they're on the plugin's own.
fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.channels:kept".into()]
}

pub const TASK: EntityDef = EntityDef {
    kind: "chan_task",
    table: "chan_task",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};
pub const KEPT: EntityDef = EntityDef {
    kind: "chan_kept",
    table: "chan_kept",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

/// The config fields that say whose bot it is (`kinds::keep_over`).
pub const TOKEN_KEYS: [&str; 2] = ["token", "botToken"];

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(TASK)?;
    store.define_entity(KEPT)
}

/// One channel task's origin.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TaskRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<Remote>,
    /// `(channel, by)`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<(String, Option<String>)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away: Option<AwayEntry>,
}

/// One transport's own state, and the mark of the token it was kept under.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KeptRow {
    pub mark: String,
    pub kept: Map<String, Value>,
}

/// A transport's secret config fields as kept: `(path, value)`, `None` when it has none now.
pub type KeptSecrets = Vec<(String, Option<Value>)>;

/// What a start reads back.
#[derive(Debug, Default)]
pub struct Loaded {
    pub tasks: Vec<(String, TaskRow)>,
    pub kept: HashMap<String, KeptRow>,
}

pub async fn load(store: &Store) -> wisp_store::Result<Loaded> {
    store
        .read_async(|r| {
            let rows = |kind: &str| -> wisp_store::Result<Vec<(String, Value)>> {
                Ok(r.query(kind, &Query::new())?
                    .iter()
                    .filter_map(|x| Some((x.get("id")?.as_str()?.to_owned(), x.get("body").cloned()?)))
                    .collect())
            };
            let tasks = rows(TASK.kind)?.into_iter().filter_map(|(id, b)| Some((id, serde_json::from_value(b).ok()?))).collect();
            let kept = rows(KEPT.kind)?.into_iter().filter_map(|(id, b)| Some((id, serde_json::from_value(b).ok()?))).collect();
            Ok(Loaded { tasks, kept })
        })
        .await
}

fn row(id: &str, body: &impl Serialize) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), serde_json::to_value(body)?);
    Ok(r)
}

/// The mark of the bot a config is for: a hash keyed with this wisp's own signing key (`channels/sign`), so the
/// token never reaches the store and a guessed one can't be checked against it.
pub fn mark_of(key: &str, cfg: &Value) -> String {
    let t: Vec<&str> = TOKEN_KEYS.iter().map(|k| cfg.get(*k).and_then(Value::as_str).unwrap_or_default()).collect();
    wisp_channels_core::sign::sha256_hex(format!("wisp.channels kept\n{key}\n{}", t.join("\n")).as_bytes())
}

/// The secret kept at `path` (dotted) in a transport's config.
pub fn secret_key(transport: &str, path: &str) -> String {
    format!("channels/kept/{transport}/{path}")
}

/// Takes `path` (dotted: `hook.secret`) out of `o`.
pub fn take_path(o: &mut Map<String, Value>, path: &str) -> Option<Value> {
    match path.split_once('.') {
        None => o.remove(path),
        Some((head, rest)) => take_path(o.get_mut(head)?.as_object_mut()?, rest),
    }
}

/// Puts `v` at `path` (dotted) in `o`, when its parent is there (a secret without its object is stale).
pub fn put_path(o: &mut Map<String, Value>, path: &str, v: Value) {
    match path.split_once('.') {
        None => {
            o.insert(path.to_owned(), v);
        }
        Some((head, rest)) => {
            if let Some(inner) = o.get_mut(head).and_then(Value::as_object_mut) {
                put_path(inner, rest, v);
            }
        }
    }
}

/// A task's origin changed: its row is written again (nothing kept: the row goes). Read and submitted under one
/// lock, so a later change is never overtaken by an older snapshot (the writer runs writes in submit order).
pub fn put_task(st: &State, id: &str) {
    let Some(store) = st.store.get() else { return };
    let _turn = lock(&st.task_turn);
    let r = st.task_row(id);
    let id = id.to_owned();
    store.write_detached(move |w| {
        if r == TaskRow::default() {
            w.del(TASK.kind, id)?;
        } else {
            w.upsert(TASK.kind, row(&id, &r)?)?;
        }
        Ok(())
    });
}

/// A task went: so does its origin.
pub fn drop_task(st: &State, id: &str) {
    let Some(store) = st.store.get() else { return };
    let _turn = lock(&st.task_turn);
    let id = id.to_owned();
    store.write_detached(move |w| w.del(TASK.kind, id).map(|_| ()));
}

/// What `transport` keeps now, split into its row and its secrets: its config less what's declared.
fn split(st: &State, transport: &str) -> Option<(KeptRow, KeptSecrets)> {
    let cfg = lock(&st.cfg).get(transport).cloned()?;
    let declared = lock(&st.declared).get(transport).cloned().unwrap_or_default();
    let paths = lock(&st.secret_paths).get(transport).cloned().unwrap_or_default();
    let mut kept = cfg.as_object().cloned().unwrap_or_default();
    kept.retain(|k, _| !declared.contains(k) && !TOKEN_KEYS.contains(&k.as_str()));
    let secrets = paths.iter().filter(|p| !declared.contains(p)).map(|p| (p.clone(), take_path(&mut kept, p))).collect();
    Some((KeptRow { mark: mark_of(&lock(&st.key), &cfg), kept }, secrets))
}

fn submit_kept(store: &Store, transport: &str, body: KeptRow) {
    let name = transport.to_owned();
    store.write_detached(move |w| w.upsert(KEPT.kind, row(&name, &body)?).map(|_| ()));
}

/// What `transport` keeps changed (or may have): written when it differs from what was written last. The row is
/// submitted under the `written` lock, so rows land in the order the state moved. A changed secret is saved first
/// (one at a time, the newest values), then the newest row: a row never names a webhook whose secret isn't kept.
pub fn put_kept(ctx: &Ctx, st: &Arc<State>, transport: &str) {
    let Some(store) = st.store.get() else { return };
    let mut last = lock(&st.written);
    let Some((r, secrets)) = split(st, transport) else { return };
    let was = last.insert(transport.to_owned(), (r.clone(), secrets.clone()));
    let row_changed = was.as_ref().map(|(row, _)| row) != Some(&r);
    let secrets_changed = was.as_ref().map(|(_, s)| s) != Some(&secrets);
    let sec = wisp_kernel::services::secrets(ctx).ok().filter(|_| secrets_changed);
    let Some(sec) = sec else {
        if row_changed {
            submit_kept(store, transport, r);
        }
        return;
    };
    drop(last);
    let (st, store, transport) = (st.clone(), store.clone(), transport.to_owned());
    ctx.spawn(async move {
        let mut saved = st.secrets_saved.lock().await;
        let newest = lock(&st.written).get(&transport).map(|(_, s)| s.clone()).unwrap_or_default();
        let had = saved.get(&transport).cloned().unwrap_or_default();
        for (path, v) in newest.iter().filter(|x| !had.contains(x)) {
            let key = secret_key(&transport, path);
            let r = match v.as_ref().filter(|v| !v.is_null()) {
                Some(v) => sec.set(&key, &v.to_string()).await,
                None => sec.delete(&key).await,
            };
            if let Err(e) = r {
                tracing::warn!(%key, "channels: a kept secret wasn't saved: {}", e.message);
            }
        }
        saved.insert(transport.clone(), newest);
        let last = lock(&st.written);
        if let Some((row, _)) = last.get(&transport) {
            submit_kept(&store, &transport, row.clone());
        }
    });
}

/// The state `transport` kept under the same token as `declared`, its secrets put back, ready for
/// `kinds::keep_over` (it carries the declared token, so that keeps it). Once per start.
pub fn restore(st: &State, transport: &str, declared: &Value) -> Option<Value> {
    let r = lock(&st.restored).remove(transport)?;
    if r.mark != mark_of(&lock(&st.key), declared) {
        return None;
    }
    let mut kept = r.kept;
    for k in TOKEN_KEYS {
        if let Some(v) = declared.get(k) {
            kept.insert(k.to_owned(), v.clone());
        }
    }
    Some(Value::Object(kept))
}

/// Reads the tables (and the kept secrets) into `st`: the start's first act finds them.
pub async fn read_into(ctx: &Ctx, st: &State, store: Store, secret_paths: &[(String, Vec<String>)]) -> wisp_store::Result<()> {
    install(&store)?;
    let loaded = load(&store).await?;
    for (id, t) in loaded.tasks {
        st.put_row(&id, t);
    }
    let mut kept = loaded.kept;
    if let Ok(sec) = wisp_kernel::services::secrets(ctx) {
        for (transport, paths) in secret_paths {
            let Some(r) = kept.get_mut(transport) else { continue };
            for p in paths {
                if let Ok(Some(v)) = sec.get(&secret_key(transport, p)).await {
                    put_path(&mut r.kept, p, serde_json::from_str(&v).unwrap_or(Value::String(v)));
                }
            }
        }
    }
    *lock(&st.restored) = kept;
    let _ = st.store.set(store);
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_store::{Location, SystemClock};

    #[test]
    fn the_channels_tables_migrate_once_and_hold_a_tasks_origin_and_a_transports_state() {
        let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
        install(&store).unwrap();
        install(&store).unwrap(); // a second start finds them made
        let origin = TaskRow {
            remote: Some(Map::from_iter([("tg".into(), json!([12, 13]))])),
            started: Some(("telegram".into(), None)),
            away: None,
        };
        let kept = KeptRow { mark: "m".into(), kept: Map::from_iter([("chatId".into(), json!(42)), ("offset".into(), json!(8))]) };
        let (o, k) = (origin.clone(), kept.clone());
        store
            .write_blocking(move |w| {
                w.upsert(TASK.kind, row("s1", &o)?)?;
                w.upsert(KEPT.kind, row("telegram", &k)?).map(|_| ())
            })
            .unwrap();
        let got = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(load(&store)).unwrap();
        assert_eq!(got.tasks, vec![("s1".to_owned(), origin)]);
        assert_eq!(got.kept.get("telegram"), Some(&kept));
    }

    #[test]
    fn a_secret_path_comes_out_of_the_kept_state_and_goes_back_only_under_its_object() {
        let mut o = json!({ "hook": { "url": "u", "secret": "s" }, "offset": 3 }).as_object().cloned().unwrap();
        assert_eq!(take_path(&mut o, "hook.secret"), Some(json!("s")));
        assert_eq!(Value::Object(o.clone()), json!({ "hook": { "url": "u" }, "offset": 3 }));
        assert_eq!(take_path(&mut o, "nope.secret"), None);
        put_path(&mut o, "hook.secret", json!("s"));
        assert_eq!(o["hook"]["secret"], "s");
        o.remove("hook");
        put_path(&mut o, "hook.secret", json!("s"));
        assert!(o.get("hook").is_none(), "a webhook dropped since: its secret stays out");
        assert_ne!(mark_of("k", &json!({ "token": "a" })), mark_of("k", &json!({ "token": "b" })));
        assert_ne!(mark_of("k", &json!({ "token": "a" })), mark_of("j", &json!({ "token": "a" })), "keyed with this wisp's own key");
    }

    #[test]
    fn telegrams_webhook_secret_and_its_declared_fields_stay_out_of_its_row() {
        let st = State::default();
        let cfg =
            json!({ "enabled": true, "token": "123:abc", "chatId": "42", "offset": 8, "hook": { "url": "u", "secret": "s", "seen": [7] } });
        lock(&st.cfg).insert("telegram".into(), cfg.clone());
        lock(&st.declared).insert("telegram".into(), vec!["enabled".into(), "token".into()]);
        lock(&st.secret_paths).insert("telegram".into(), vec!["token".into(), "hook.secret".into()]);
        let (r, secrets) = split(&st, "telegram").unwrap();
        assert_eq!(Value::Object(r.kept.clone()), json!({ "chatId": "42", "offset": 8, "hook": { "url": "u", "seen": [7] } }));
        assert_eq!(secrets, vec![("hook.secret".to_owned(), Some(json!("s")))], "the token is declared: the resource keeps it");
        assert_eq!(r.mark, mark_of("", &cfg));
        let mut back = r.clone();
        put_path(&mut back.kept, "hook.secret", json!("s"));
        lock(&st.restored).insert("telegram".into(), back);
        assert!(restore(&st, "telegram", &json!({ "token": "999:other" })).is_none(), "another bot: nothing carries over");
        lock(&st.restored).insert("telegram".into(), r);
        let again = restore(&st, "telegram", &json!({ "token": "123:abc" })).unwrap();
        assert_eq!((again["token"].as_str(), again["offset"].as_i64()), (Some("123:abc"), Some(8)), "ready for keep_over");
        assert!(restore(&st, "telegram", &json!({ "token": "123:abc" })).is_none(), "once per start");
    }
}
