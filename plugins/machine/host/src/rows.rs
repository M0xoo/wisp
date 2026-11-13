//! This Mac's two rows (`machine.snapshot`, `machine.load`, both id `this`): their tables, their topics and
//! how a view becomes them.

use serde_json::{Value, json};
use wisp_machine_api::this_mac::{LoadReading, MachineView};
use wisp_store::{Col, EntityDef, Migration, Row, Store};

pub const OWNER: &str = "machine";
pub const SNAPSHOT_TOPIC: &str = "plugin:wisp.machine:snapshot";
pub const LOAD_TOPIC: &str = "plugin:wisp.machine:load";

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE machine_snapshot (id TEXT PRIMARY KEY, at INTEGER NOT NULL, platform TEXT NOT NULL, mem TEXT, cpu TEXT, disk TEXT, wisp TEXT,
       guard TEXT, tasks TEXT, crew TEXT, leftovers TEXT, leftover_groups TEXT, history TEXT, reclaim TEXT, cleanup TEXT) STRICT;
     CREATE TABLE machine_load (id TEXT PRIMARY KEY, at INTEGER NOT NULL, platform TEXT NOT NULL, mem_free_pct REAL, runs INTEGER NOT NULL,
       held TEXT, limits TEXT, paused_until INTEGER NOT NULL, left_behind INTEGER NOT NULL) STRICT;",
),
// v1's Now line reads the CPU too ("CPU at 50% of its cores"): the guard's reading, as a share of all cores
Migration::sql(2, "ALTER TABLE machine_load ADD COLUMN cpu REAL;")];

fn snapshot_topics(_: &Row) -> Vec<String> {
    vec![SNAPSHOT_TOPIC.into()]
}
fn load_topics(_: &Row) -> Vec<String> {
    vec![LOAD_TOPIC.into()]
}

pub const SNAPSHOT: EntityDef = EntityDef {
    kind: "machine.snapshot",
    table: "machine_snapshot",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("at", Col::Int),
        ("platform", Col::Text),
        ("mem", Col::Text),
        ("cpu", Col::Text),
        ("disk", Col::Text),
        ("wisp", Col::Text),
        ("guard", Col::Text),
        ("tasks", Col::Text),
        ("crew", Col::Text),
        ("leftovers", Col::Text),
        ("leftover_groups", Col::Text),
        ("history", Col::Text),
        ("reclaim", Col::Text),
        ("cleanup", Col::Text),
    ],
    json_columns: &["mem", "cpu", "disk", "wisp", "guard", "tasks", "crew", "leftovers", "leftover_groups", "history", "reclaim"],
    parent: None,
    seq: None,
    topics: snapshot_topics,
};

pub const LOAD: EntityDef = EntityDef {
    kind: "machine.load",
    table: "machine_load",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("at", Col::Int),
        ("platform", Col::Text),
        ("mem_free_pct", Col::Real),
        ("cpu", Col::Real),
        ("runs", Col::Int),
        ("held", Col::Text),
        ("limits", Col::Text),
        ("paused_until", Col::Int),
        ("left_behind", Col::Int),
    ],
    json_columns: &["held", "limits"],
    parent: None,
    seq: None,
    topics: load_topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(SNAPSHOT)?;
    store.define_entity(LOAD)?;
    Ok(())
}

/// `darwin`, `linux`, `win32`: the page names itself from it (This Mac, This computer, This PC).
pub fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

/// The two rows, from a view and the guard's reading. `cleanup`: Settings → Worktrees' idle days, or `off`.
pub fn rows(v: &MachineView, reading: &LoadReading, paused_until: i64, cleanup: Option<&str>, platform: &str) -> (Row, Row) {
    let Value::Object(f) = serde_json::to_value(v).unwrap_or(Value::Null) else { return (Row::new(), Row::new()) };
    let mut snap = Row::new();
    snap.insert("id".into(), json!("this"));
    snap.insert("platform".into(), json!(platform));
    for (col, key) in [("at", "at"), ("mem", "mem"), ("cpu", "cpu"), ("disk", "disk"), ("wisp", "wisp"), ("guard", "guard"), ("tasks", "tasks"), ("crew", "crew"), ("leftovers", "leftovers"), ("leftover_groups", "leftoverGroups"), ("history", "history"), ("reclaim", "reclaim")] {
        snap.insert(col.into(), f.get(key).cloned().unwrap_or(Value::Null));
    }
    snap.insert("cleanup".into(), cleanup.map_or(Value::Null, |c| json!(c)));
    let mut load = Row::new();
    load.insert("id".into(), json!("this"));
    load.insert("at".into(), json!(reading.at));
    load.insert("platform".into(), json!(platform));
    load.insert("mem_free_pct".into(), reading.mem_free_pct.map_or(Value::Null, |n| json!(n)));
    load.insert("cpu".into(), reading.cpu.map_or(Value::Null, |n| json!(n)));
    load.insert("runs".into(), json!(reading.runs));
    load.insert("held".into(), serde_json::to_value(&reading.held).unwrap_or(Value::Null));
    load.insert("limits".into(), serde_json::to_value(reading.limits).unwrap_or(Value::Null));
    load.insert("paused_until".into(), json!(paused_until));
    load.insert("left_behind".into(), json!(v.leftovers.len()));
    (snap, load)
}


#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use wisp_machine_api::this_mac::{Leftover, Limits, MemoryPer, WispUse};
    use wisp_machine_core::this_mac::view::{self, ViewInput};
    use wisp_store::{Location, SystemClock};

    /// The page and the chip read two flat rows, id `this`, on the topics they watch; the two-word fields are
    /// the store's snake-case columns (`leftover_groups`, `mem_free_pct`, `paused_until`, `left_behind`).
    #[tokio::test]
    async fn the_snapshot_and_load_rows_are_published_on_the_topics_the_ui_watches() {
        let db = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
        install(&db).unwrap();
        let reading = LoadReading { mem_free_pct: Some(42.5), cpu: Some(10.0), pressure: None, at: 7, runs: 2, limits: Limits { floor: Some(15), ..Limits::default() }, held: None };
        let left = Leftover { pid: 9, command: "node dev".into(), rss: 5, cpu: 0.0, task: Some("t1".into()), since: 1 };
        let v = view::build(
            ViewInput { now: 7, mem_total: 16, cores: 8, memory: MemoryPer::Rss, reading: &reading, hold: None, paused_until: 0, battery: None, battery_hold: None, rows: &std::collections::BTreeMap::default(), tasks: &HashMap::new(), worktrees: None, harness: None, wisp: WispUse { rss: 3, cpu: Some(1.0) }, leftovers: vec![left], groups: Vec::new(), history: Vec::new() },
            Vec::new(),
        );
        let (snap, load) = rows(&v, &reading, 99, Some("7"), "darwin");
        db.write(move |w| w.upsert(SNAPSHOT.kind, snap).and_then(|_| w.upsert(LOAD.kind, load)).map(|_| ())).await.unwrap();
        let s = db.read(|r| r.get("machine.snapshot", "this")).unwrap().unwrap();
        assert_eq!(s["platform"], "darwin");
        assert_eq!(s["mem"]["freePct"], 42.5);
        assert_eq!(s["leftovers"][0]["pid"], 9);
        assert!(s["leftover_groups"].is_array());
        assert_eq!(s["cleanup"], "7");
        let l = db.read(|r| r.get("machine.load", "this")).unwrap().unwrap();
        assert_eq!(l["mem_free_pct"], 42.5);
        assert_eq!(l["cpu"], 10.0, "v1's Now line: CPU at 10% of its cores");
        assert_eq!(l["paused_until"], 99);
        assert_eq!(l["left_behind"], 1);
        assert_eq!(l["limits"]["floor"], 15);
        assert_eq!((SNAPSHOT.topics)(&s), vec!["plugin:wisp.machine:snapshot".to_owned()]);
        assert_eq!((LOAD.topics)(&l), vec!["plugin:wisp.machine:load".to_owned()]);
    }

}
