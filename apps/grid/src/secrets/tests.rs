#![allow(clippy::unwrap_used)]

use super::*;

fn secrets() -> (Arc<Db>, Secrets) {
    let db = Arc::new(Db::memory().unwrap());
    db.with(|c| c.execute("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'ada', 0)", [])).unwrap();
    (db.clone(), Secrets::for_test(db, [7; 32]).unwrap())
}

#[test]
fn seal_open_forget() {
    let (_db, s) = secrets();
    assert_eq!(s.open_secret("u1", "x").unwrap(), None);
    s.seal("u1", "x", "hello").unwrap();
    assert_eq!(s.open_secret("u1", "x").unwrap().as_deref(), Some("hello"));
    let a = s.ensure("u1", "wisp-proxy").unwrap();
    assert_eq!(s.ensure("u1", "wisp-proxy").unwrap(), a);
    s.forget("u1").unwrap();
    assert_eq!(s.open_secret("u1", "x").unwrap(), None);
}

#[test]
fn sealed_values_are_bound_to_user_and_purpose() {
    let (db, s) = secrets();
    s.seal("u1", "a", "v").unwrap();
    // Moving the sealed text to another purpose doesn't open it.
    db.with(|c| c.execute("UPDATE user_secrets SET purpose = 'b'", [])).unwrap();
    assert!(s.open_secret("u1", "b").is_err());
}

#[test]
fn signatures() {
    let (_db, s) = secrets();
    let sig = s.sign("csrf|abc");
    assert!(s.verify("csrf|abc", &sig));
    assert!(!s.verify("csrf|abd", &sig));
    assert!(!s.verify("csrf|abc", ""));
}

#[test]
fn v1_sealed_format_round_trips() {
    let k = [3u8; 32];
    let sealed = gcm(&k, b"secret", "u|p").unwrap();
    assert_eq!(sealed.split('.').count(), 3);
    assert_eq!(ungcm(&k, &sealed, "u|p").unwrap(), b"secret");
    assert!(ungcm(&k, "a.b", "u|p").is_err());
}

#[test]
fn master_file_rotation() {
    let dir = std::env::temp_dir().join(format!("wisp-grid-secrets-{}", token("", 6)));
    assert!(ensure_master(&dir).unwrap());
    assert!(!ensure_master(&dir).unwrap());
    let db = Arc::new(Db::memory().unwrap());
    db.with(|c| c.execute("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'ada', 0)", [])).unwrap();
    let s = Secrets::open(db.clone(), &dir, &Env::new()).unwrap();
    s.seal("u1", "x", "v").unwrap();
    assert_eq!(add_master_key(&dir).unwrap(), "k2");
    let s2 = Secrets::open(db, &dir, &Env::new()).unwrap();
    assert_eq!(s2.rewrap().unwrap(), 1);
    assert_eq!(s2.open_secret("u1", "x").unwrap().as_deref(), Some("v"));
    let gone = prune_master_keys(&dir, &std::collections::HashSet::from(["k2".to_owned()])).unwrap();
    assert_eq!(gone, vec!["k1".to_owned()]);
    let _ = std::fs::remove_dir_all(dir);
}
