//! Forward-only migrations per owner, snapshots, refusing a newer database (ported from migrate.test.ts).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::unnecessary_wraps
)]

mod common;

use std::sync::Arc;

use common::tmp_home;
use serde_json::json;
use wisp_kernel::Code;
use wisp_store::{
    Col, EntityDef, Location, ManualClock, MigrateReport, Migration, Query, Row, Store, StoreError,
    row,
};

const V1: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE crew_member (id TEXT PRIMARY KEY, name TEXT) STRICT",
)];

fn helper_role(db: &wisp_store::rusqlite::Connection) -> Result<(), StoreError> {
    db.execute(
        "UPDATE crew_member SET role = 'helper' WHERE role IS NULL",
        [],
    )?;
    Ok(())
}

const V3: &[Migration] = &[
    V1[0],
    Migration::sql(2, "ALTER TABLE crew_member ADD COLUMN role TEXT"),
    Migration::func(3, helper_role),
];

fn at(home: &std::path::Path, now: i64) -> Store {
    Store::open(
        Location::Path(home.join("wisp.db")),
        Arc::new(ManualClock::new(now)),
    )
    .unwrap()
}

fn crew(_: &Row) -> Vec<String> {
    vec!["crew".into()]
}
const MEMBER: EntityDef = EntityDef {
    kind: "member",
    table: "crew_member",
    key: "id",
    columns: &[("id", Col::Text), ("name", Col::Text)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics: crew,
};

#[test]
fn a_fresh_database_migrates_kernel_and_owner_from_v0_with_no_snapshot() {
    let home = tmp_home();
    let store = at(&home, 5000);
    // 2: the durable event log (ADR-0044)
    assert_eq!(store.schema_version("kernel").unwrap(), 2);
    assert_eq!(
        store.migrate("crew", V1).unwrap(),
        MigrateReport {
            from: 0,
            to: 1,
            snapshot: None
        }
    );
    assert_eq!(
        store.migrate("crew", V1).unwrap(),
        MigrateReport {
            from: 1,
            to: 1,
            snapshot: None
        },
        "again is a no-op"
    );
    assert!(!home.join("backups").exists());
}

#[test]
fn an_upgrade_snapshots_first_then_runs_each_step_and_the_data_survives() {
    let home = tmp_home();
    let store = at(&home, 5000);
    store.migrate("crew", V1).unwrap();
    store.define_entity(MEMBER).unwrap();
    store
        .write_blocking(|w| w.upsert("member", row!({"id": "m1", "name": "Ada"})))
        .unwrap();
    store.close();
    let store = at(&home, 7000);
    let report = store.migrate("crew", V3).unwrap();
    assert_eq!((report.from, report.to), (1, 3));
    let snap = report.snapshot.unwrap();
    assert_eq!(snap, home.join("backups").join("crew-v1-7000.db"));
    store
        .define_entity(EntityDef {
            columns: &[("id", Col::Text), ("name", Col::Text), ("role", Col::Text)],
            ..MEMBER
        })
        .unwrap();
    assert_eq!(
        store.get("member", "m1").unwrap(),
        Some(row!({"id": "m1", "name": "Ada", "role": "helper"}))
    );
    let old = Store::open(Location::Path(snap), Arc::new(ManualClock::new(0))).unwrap();
    assert_eq!(
        old.schema_version("crew").unwrap(),
        1,
        "the snapshot holds the database as it was"
    );
}

#[test]
fn a_database_newer_than_the_code_is_refused_with_a_clear_error() {
    let home = tmp_home();
    let store = at(&home, 1);
    store.migrate("crew", V3).unwrap();
    store.close();
    let store = at(&home, 2);
    let err = store.migrate("crew", V1).unwrap_err();
    assert_eq!(err.code(), Code::Conflict);
    assert!(
        err.to_string()
            .contains("crew schema v3, but this wisp only knows up to v1"),
        "{err}"
    );
    assert_eq!(
        store.schema_version("crew").unwrap(),
        3,
        "nothing was touched"
    );
}

#[test]
fn a_failing_migration_rolls_back_that_step_only_and_keeps_the_version_it_reached() {
    let store = Store::open(Location::Memory, Arc::new(ManualClock::new(0))).unwrap();
    let bad = [
        V1[0],
        Migration::sql(
            2,
            "ALTER TABLE crew_member ADD COLUMN x TEXT; THIS IS NOT SQL",
        ),
    ];
    assert!(
        store
            .migrate("crew", &bad)
            .unwrap_err()
            .to_string()
            .contains("crew migration v2 failed")
    );
    assert_eq!(store.schema_version("crew").unwrap(), 1);
    assert_eq!(
        store.query("plugin", &Query::new()).unwrap(),
        vec![],
        "the store still works"
    );
}

#[test]
fn lists_must_be_numbered_owners_well_formed() {
    let store = Store::open(Location::Memory, Arc::new(ManualClock::new(0))).unwrap();
    assert!(
        store
            .migrate("crew", &[Migration::sql(2, "")])
            .unwrap_err()
            .to_string()
            .contains("numbered 1, 2, 3")
    );
    assert!(
        store
            .migrate("Bad Owner", V1)
            .unwrap_err()
            .to_string()
            .contains("bad migration owner")
    );
    // a migration from inside a write would wait on the writer it runs on
    let s = store.clone();
    let err = store
        .write_blocking(move |_| s.migrate("crew", V1).map(|_| ()))
        .unwrap_err();
    assert_eq!(err.code(), Code::Invalid);
}

#[test]
fn a_table_rebuild_with_foreign_keys_off_is_checked_before_it_commits() {
    let store = Store::open(Location::Memory, Arc::new(ManualClock::new(0))).unwrap();
    store.migrate("crew", &[Migration::sql(1, "CREATE TABLE crew_team (id TEXT PRIMARY KEY) STRICT; CREATE TABLE crew_seat (id TEXT PRIMARY KEY, team TEXT REFERENCES crew_team (id)) STRICT")]).unwrap();
    let broken =
        Migration::sql(2, "INSERT INTO crew_seat VALUES ('s', 'ghost')").with_foreign_keys_off();
    assert!(
        store
            .migrate("crew", &[Migration::sql(1, ""), broken])
            .unwrap_err()
            .to_string()
            .contains("broken foreign keys")
    );
    assert_eq!(store.schema_version("crew").unwrap(), 1);
}

#[test]
fn old_snapshots_are_pruned_three_per_owner_are_kept() {
    let home = tmp_home();
    let mut steps = vec![Migration::sql(
        1,
        "CREATE TABLE crew_x (id TEXT PRIMARY KEY) STRICT",
    )];
    for v in 2..=6u32 {
        steps.push(Migration::sql(
            v,
            Box::leak(format!("ALTER TABLE crew_x ADD COLUMN c{v} TEXT").into_boxed_str()),
        ));
        let store = at(&home, 1000 * i64::from(v));
        store.migrate("crew", &steps).unwrap();
        store.close();
    }
    let mut kept: Vec<_> = std::fs::read_dir(home.join("backups"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    kept.sort();
    assert_eq!(
        kept,
        vec!["crew-v3-4000.db", "crew-v4-5000.db", "crew-v5-6000.db"]
    );
    let _ = json!(null);
}
