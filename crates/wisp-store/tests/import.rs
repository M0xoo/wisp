//! The v1 import framework: one tx per file, resumable by (file, mtime, size), dual write (import.test.ts).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::unnecessary_wraps
)]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{open, tmp_home};
use serde_json::{Value, json};
use wisp_kernel::CancellationToken;
use wisp_store::{ImportFile, ImportHandler, ImportOptions, StoreError, Writer, import_files, row};

// A v1 sessions/ folder: <id>.json, .light/ summaries, and a temp file a crash left (x.json.3.tmp).
fn v1_sessions() -> PathBuf {
    let dir = tmp_home().join("sessions");
    fs::create_dir_all(dir.join(".light")).unwrap();
    for id in ["s1", "s2", "s3"] {
        fs::write(dir.join(format!("{id}.json")), json!({"id": id, "title": format!("task {id}"), "turns": [{"prompt": "hi", "activity": [{"t": "text"}]}]}).to_string()).unwrap();
    }
    fs::write(dir.join(".light").join("s1.json"), "{}").unwrap();
    fs::write(dir.join("s4.json.3.tmp"), "{\"id\":\"s4\"").unwrap();
    dir
}

// The fake owner handler: a session row, as the runtime plugin would write it.
fn write_session(file: &ImportFile, w: &mut Writer<'_>) -> Result<(), StoreError> {
    let s: Value = file.json()?;
    let id = s["id"].as_str().unwrap_or_default().to_owned();
    w.upsert("session", row!({"id": id, "title": s["title"], "state": "idle", "archived": false, "updated_at": 1, "extra": null}))?;
    for (i, t) in s["turns"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        w.upsert("session", row!({"id": id, "extra": {"turns": i + 1, "events": t["activity"].as_array().map_or(0, Vec::len)}}))?;
    }
    Ok(())
}

fn handler(seen: Arc<Mutex<Vec<String>>>) -> ImportHandler {
    Arc::new(move |file, w| {
        seen.lock().unwrap().push(file.name.clone());
        write_session(file, w)
    })
}

fn opts(dir: &Path) -> ImportOptions {
    ImportOptions::new("runtime.sessions", dir)
}

#[tokio::test]
async fn imports_each_matching_file_once_ignoring_temp_files_and_folders() {
    let f = open();
    let dir = v1_sessions();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let r = import_files(&f.store, opts(&dir), handler(seen.clone()))
        .await
        .unwrap();
    assert_eq!(r.imported, vec!["s1.json", "s2.json", "s3.json"]);
    assert_eq!((r.unchanged, r.failed.len(), r.stopped), (0, 0, false));
    assert_eq!(
        f.store.get("session", "s1").unwrap().unwrap()["extra"],
        json!({"turns": 1, "events": 1})
    );
    let again = import_files(&f.store, opts(&dir), handler(seen.clone()))
        .await
        .unwrap();
    assert_eq!((again.imported.len(), again.unchanged), (0, 3));
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn a_file_changed_since_its_import_is_imported_again() {
    let f = open();
    let dir = v1_sessions();
    import_files(&f.store, opts(&dir), handler(Arc::default()))
        .await
        .unwrap();
    fs::write(
        dir.join("s2.json"),
        json!({"id": "s2", "title": "renamed in v1", "turns": []}).to_string(),
    )
    .unwrap();
    let r = import_files(&f.store, opts(&dir), handler(Arc::default()))
        .await
        .unwrap();
    assert_eq!(r.imported, vec!["s2.json"]);
    assert_eq!(
        f.store.get("session", "s2").unwrap().unwrap()["title"],
        json!("renamed in v1")
    );
}

#[tokio::test]
async fn a_corrupt_file_rolls_back_alone_is_recorded_and_not_retried_until_it_changes() {
    let f = open();
    let dir = v1_sessions();
    fs::write(dir.join("s2.json"), "{\"id\":\"s2\",\"title\":\"cut o").unwrap();
    let r = import_files(&f.store, opts(&dir), handler(Arc::default()))
        .await
        .unwrap();
    assert_eq!(r.imported, vec!["s1.json", "s3.json"]);
    assert_eq!(r.failed[0].0, "s2.json");
    assert_eq!(f.store.get("session", "s2").unwrap(), None);
    let again = import_files(&f.store, opts(&dir), handler(Arc::default()))
        .await
        .unwrap();
    assert_eq!(
        (again.imported.len(), again.unchanged, again.failed.len()),
        (0, 3, 0)
    );
}

#[tokio::test]
async fn a_handler_that_fails_after_writing_leaves_none_of_that_files_rows() {
    let f = open();
    let dir = v1_sessions();
    let h: ImportHandler = Arc::new(|file, w| {
        write_session(file, w)?;
        if file.name == "s3.json" {
            Err(StoreError::Invalid("unknown turn shape".into()))
        } else {
            Ok(())
        }
    });
    let r = import_files(&f.store, opts(&dir), h).await.unwrap();
    assert_eq!(
        r.failed,
        vec![("s3.json".to_owned(), "unknown turn shape".to_owned())]
    );
    assert_eq!(f.store.get("session", "s3").unwrap(), None);
    assert_eq!(
        f.store.count("session", &wisp_store::Query::new()).unwrap(),
        2
    );
}

#[tokio::test]
async fn stopped_by_its_token_it_resumes_where_it_was() {
    let f = open();
    let dir = v1_sessions();
    let stop = CancellationToken::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (s, t) = (seen.clone(), stop.clone());
    let h: ImportHandler = Arc::new(move |file, w| {
        s.lock().unwrap().push(file.name.clone());
        t.cancel();
        write_session(file, w)
    });
    let first = import_files(
        &f.store,
        ImportOptions {
            cancel: Some(stop),
            ..opts(&dir)
        },
        h,
    )
    .await
    .unwrap();
    assert_eq!(
        (first.imported.clone(), first.stopped),
        (vec!["s1.json".to_owned()], true)
    );
    let rest = import_files(&f.store, opts(&dir), handler(seen.clone()))
        .await
        .unwrap();
    assert_eq!(
        (rest.imported, rest.unchanged),
        (vec!["s2.json".to_owned(), "s3.json".to_owned()], 1)
    );
    assert_eq!(*seen.lock().unwrap(), vec!["s1.json", "s2.json", "s3.json"]);
}

#[tokio::test]
async fn a_missing_folder_imports_nothing_a_pattern_picks_files_and_names_are_checked() {
    let f = open();
    let none = import_files(
        &f.store,
        ImportOptions::new("x", tmp_home().join("nope")),
        handler(Arc::default()),
    )
    .await
    .unwrap();
    assert!(none.imported.is_empty());
    let dir = tmp_home();
    fs::write(dir.join("budget.json"), "{}").unwrap();
    fs::write(dir.join("router.json"), "{}").unwrap();
    let names = Arc::new(Mutex::new(Vec::new()));
    let n = names.clone();
    let o = ImportOptions {
        pattern: Some(Arc::new(|n: &str| n == "budget.json")),
        ..ImportOptions::new("x", &dir)
    };
    let h: ImportHandler = Arc::new(move |file, _| {
        n.lock().unwrap().push(file.name.clone());
        Ok(())
    });
    import_files(&f.store, o, h).await.unwrap();
    assert_eq!(*names.lock().unwrap(), vec!["budget.json"]);
    assert!(
        import_files(
            &f.store,
            ImportOptions::new("Bad Name", &dir),
            handler(Arc::default())
        )
        .await
        .is_err()
    );
}
