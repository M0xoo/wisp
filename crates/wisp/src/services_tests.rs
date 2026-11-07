use super::*;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-svc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test]
async fn secrets_round_trip_in_v1_shape_and_0600() {
    let d = tmp("secrets");
    let s = FileSecrets::new(&d);
    s.set("token", "a").await.unwrap();
    s.set("telegram/bot", "b").await.unwrap();
    assert_eq!(s.get("token").await.unwrap().as_deref(), Some("a"));
    assert_eq!(s.get("wisp/token").await.unwrap().as_deref(), Some("a"));
    assert_eq!(s.keys("").await.unwrap(), vec!["telegram/bot", "token"]);
    let on_disk: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("secrets.json")).unwrap()).unwrap();
    assert_eq!(on_disk, serde_json::json!({"telegram": {"bot": "b"}, "wisp": {"token": "a"}}));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(d.join("secrets.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    s.delete("telegram/bot").await.unwrap();
    assert_eq!(s.keys("tele").await.unwrap(), Vec::<String>::new());
    assert!(!d.join("secrets.json.tmp").exists(), "the tmp file is renamed over, never left behind");
    // a second handle (another process later) reads what the first wrote
    assert_eq!(FileSecrets::new(&d).get("token").await.unwrap().as_deref(), Some("a"));
}

#[tokio::test]
async fn a_v1_file_reads_as_it_is_and_odd_values_are_dropped() {
    let d = tmp("v1");
    std::fs::write(d.join("secrets.json"), r#"{"wisp":{"grid":"g","n":3},"slack":{"hook":"h"}}"#).unwrap();
    let s = FileSecrets::new(&d);
    assert_eq!(s.get("grid").await.unwrap().as_deref(), Some("g"));
    assert_eq!(s.get("n").await.unwrap(), None);
    assert_eq!(s.get("slack/hook").await.unwrap().as_deref(), Some("h"));
}

#[tokio::test]
async fn concurrent_writes_all_land() {
    let d = tmp("concurrent");
    let s = FileSecrets::new(&d);
    let mut tasks = Vec::new();
    for i in 0..20 {
        let s = s.clone();
        tasks.push(tokio::spawn(async move { s.set(&format!("k{i}"), "v").await }));
    }
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    assert_eq!(FileSecrets::new(&d).keys("k").await.unwrap().len(), 20);
}

#[test]
fn home_is_wisp_home_or_dot_wisp() {
    assert_eq!(home(Some("/x"), Some(PathBuf::from("/u"))), PathBuf::from("/x"));
    assert_eq!(home(Some(""), Some(PathBuf::from("/u"))), PathBuf::from("/u/.wisp"));
    assert_eq!(home(None, Some(PathBuf::from("/u"))), PathBuf::from("/u/.wisp"));
}

#[test]
fn clock_moves() {
    assert!(SystemClock.now_ms() > 1_700_000_000_000);
}
