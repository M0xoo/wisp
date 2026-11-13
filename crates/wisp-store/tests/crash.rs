//! Crash safety with a real crash: a child process aborts inside a write transaction; reopening finds
//! every committed row with its change row and nothing of the aborted transaction.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty, clippy::unnecessary_wraps)]

mod common;

use std::process::Command;

use common::{event, open_disk, session};
use serde_json::Value;
use wisp_store::Query;

const CHILD: &str = "WISP_STORE_CRASH_HOME";

/// Runs only as the child: commits two transactions, then dies inside the third.
#[test]
fn crash_child() {
    let Some(home) = std::env::var_os(CHILD) else {
        return;
    };
    let f = open_disk(Some(home.into()));
    f.store.write_blocking(|w| w.upsert("session", session("kept"))).unwrap();
    f.store.write_blocking(|w| w.append("event", (0..50).map(|i| event("kept", i, "x", Value::Null)).collect())).unwrap();
    let _: Result<(), _> = f.store.write_blocking(|w| {
        w.upsert("session", session("lost"))?;
        w.append("event", (50..100).map(|i| event("kept", i, "x", Value::Null)).collect())?;
        std::process::abort();
    });
}

#[test]
fn a_process_that_dies_mid_transaction_loses_only_that_transaction() {
    let home = common::tmp_home();
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_child", "--test-threads=1"])
        .env(CHILD, &home)
        .status()
        .unwrap();
    assert!(!status.success(), "the child aborted");
    let f = open_disk(Some(home));
    assert!(f.store.get("session", "kept").unwrap().is_some());
    assert_eq!(f.store.get("session", "lost").unwrap(), None);
    assert_eq!(f.store.count("event", &Query::new()).unwrap(), 50);
    assert_eq!(f.store.head_seq().unwrap(), 2, "two committed transactions, one change row each");
    f.store.write_blocking(|w| w.upsert("session", session("after"))).unwrap();
    assert_eq!(f.store.head_seq().unwrap(), 3, "the writer carries on from the committed head");
}
