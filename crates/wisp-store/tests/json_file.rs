//! Atomic JSON files for what stays a file (json-file.test.ts).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty, clippy::unnecessary_wraps)]

mod common;

use std::fs;

use common::tmp_home;
use wisp_kernel::Clock;
use wisp_store::{JsonFile, SystemClock};

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn write_is_atomic_0600_and_reads_back_and_a_missing_file_reads_as_none() {
    let file = tmp_home().join("nested").join("secrets.json");
    let f = JsonFile::<serde_json::Value>::new(&file);
    assert_eq!(f.read().unwrap(), None);
    f.write(&serde_json::json!({"token": "a"})).unwrap();
    assert_eq!(f.read().unwrap(), Some(serde_json::json!({"token": "a"})));
    #[cfg(unix)]
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&file).unwrap().permissions()) & 0o777, 0o600);
    assert_eq!(names(file.parent().unwrap()), vec!["secrets.json"], "no temp file left");
}

#[test]
fn a_corrupt_file_fails_instead_of_reading_as_empty() {
    let file = tmp_home().join("secrets.json");
    fs::write(&file, "{\"token\": \"cut-o").unwrap();
    assert!(JsonFile::<serde_json::Value>::new(&file).read().unwrap_err().to_string().contains("not valid JSON"));
}

#[tokio::test]
async fn of_two_background_saves_only_the_newer_lands_and_a_sync_write_beats_a_save_on_its_way() {
    let dir = tmp_home();
    let f = JsonFile::<u32>::new(dir.join("prefs.json"));
    let (a, b) = tokio::join!(f.save(&1), f.save(&2));
    assert_eq!((a.unwrap(), b.unwrap()), (false, true));
    assert_eq!(f.read().unwrap(), Some(2));
    let late = f.save(&3);
    f.write(&4).unwrap();
    assert!(!late.await.unwrap());
    assert_eq!(f.read().unwrap(), Some(4));
    assert_eq!(names(&dir), vec!["prefs.json"]);
}

#[test]
fn clean_temps_removes_old_temp_files_a_crash_left_and_keeps_fresh_ones() {
    let dir = tmp_home();
    let file = dir.join("secrets.json");
    fs::write(dir.join("secrets.json.123.1.tmp"), "old").unwrap();
    fs::write(dir.join("secrets.json.123.2.tmp"), "new").unwrap();
    fs::write(dir.join("other.json.1.tmp"), "not ours").unwrap();
    let f = JsonFile::<u32>::new(&file);
    assert_eq!(f.clean_temps(SystemClock.now_ms()).unwrap(), 0, "all fresh");
    let old = fs::File::options().write(true).open(dir.join("secrets.json.123.1.tmp")).unwrap();
    old.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(300)).unwrap();
    assert_eq!(f.clean_temps(SystemClock.now_ms()).unwrap(), 1);
    assert_eq!(names(&dir), vec!["other.json.1.tmp", "secrets.json.123.2.tmp"]);
}
