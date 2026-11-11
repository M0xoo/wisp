//! v1 test/grid.test.js's published-app cases, on the module (the edge's routes are thin over it).

use super::*;
use crate::clock::ManualClock;

fn user(db: &Db, id: &str, handle: &str) -> UserRow {
    db.with(|c| c.execute("INSERT INTO users (id, handle, created_at) VALUES (?1, ?2, 0)", params![id, handle])).unwrap();
    UserRow { id: id.into(), handle: handle.into(), email: None, name: None, avatar: None, created_at: 0, disabled: 0 }
}

fn sites(tag: &str) -> (Sites, Arc<Db>, PathBuf) {
    let db = Arc::new(Db::memory().unwrap());
    let dir = std::env::temp_dir().join(format!("wisp-sites-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let s = Sites::new(db.clone(), ManualClock::new(1_000), &dir, None, Arc::new(|l: &str| format!("https://{l}.grid.test")));
    (s, db, dir)
}

#[test]
fn an_app_gets_a_public_link_updated_in_place_and_unpublished_only_by_its_owner() {
    let (s, db, dir) = sites("pub");
    let pia = user(&db, "u1", "pia");
    let dee = user(&db, "u2", "dee");
    let v1 = pack(&[("index.html", b"<h1>Slides v1</h1>"), ("js/app.js", b"console.log(1)")]);
    let out = s.publish(&pia, "it1", &v1, "Pia’s Slides!", "").unwrap();
    assert_eq!(out["url"], "https://pia-s-slides--app--pia.grid.test/");
    let row = s.by_label("pia-s-slides--app--pia").unwrap().unwrap();
    let page = s.serve("GET", "/", &row);
    assert_eq!((page.status, page.body.as_slice()), (200, b"<h1>Slides v1</h1>".as_slice()));
    assert!(page.headers.iter().any(|(k, v)| *k == "content-type" && v.starts_with("text/html")));
    assert!(page.headers.iter().any(|(k, v)| *k == "x-robots-tag" && v.contains("noindex")));
    assert_eq!(s.serve("GET", "/js/app.js", &row).body, b"console.log(1)");
    assert_eq!(s.serve("GET", "/..%2f..%2fgrid.db", &row).status, 404, "nothing outside its folder");
    assert_eq!(s.serve("POST", "/", &row).status, 405);
    assert!(s.by_label("nope--app--pia").unwrap().is_none());
    // publishing again updates the same link
    let v2 = pack(&[("index.html", b"<h1>Slides v2</h1>")]);
    assert_eq!(s.publish(&pia, "it1", &v2, "Pia’s Slides!", "").unwrap()["url"], out["url"]);
    let row = s.by_label("pia-s-slides--app--pia").unwrap().unwrap();
    assert_eq!(s.serve("GET", "/", &row).body, b"<h1>Slides v2</h1>");
    assert_eq!(s.serve("GET", "/js/app.js", &row).status, 404, "the old version went");
    assert_eq!(s.list("u1").unwrap().len(), 1);
    // someone else can't take it down
    assert!(!s.remove(&dee.id, "it1").unwrap());
    assert!(s.remove(&pia.id, "it1").unwrap());
    assert!(s.by_label("pia-s-slides--app--pia").unwrap().is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_bundle_reaching_outside_its_folder_or_without_its_entry_is_refused() {
    let (s, db, dir) = sites("bad");
    let pia = user(&db, "u1", "pia");
    let mut bad = Vec::new();
    let head = br#"{"path":"../x.html","size":0}"#;
    bad.extend_from_slice(&u32::try_from(head.len()).unwrap().to_be_bytes());
    bad.extend_from_slice(head);
    assert!(s.publish(&pia, "evil", &bad, "x", "").is_err());
    let e = s.publish(&pia, "evil", &pack(&[("readme.md", b"hi")]), "x", "").unwrap_err();
    assert!(e.to_string().contains("No index.html"), "{e}");
    assert!(s.publish(&pia, "../k", &pack(&[("index.html", b"x")]), "x", "").is_err(), "a bad key");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_grid_keeps_secrets_out_of_a_published_app_whatever_an_older_wisp_sent() {
    let (s, db, dir) = sites("secrets");
    let pia = user(&db, "u1", "pia");
    let files: Vec<(&str, &[u8])> = vec![("index.html", b"hello"), (".env", b"A=1"), (".env.local", b"B=2"), (".htaccess", b"x"), (".config/a.json", b"{}"), ("sub/.env", b"C=3"), ("sub/tls.key", b"k"), ("server.pem", b"p"), ("credentials.json", b"{}"), ("app.js", b"1"), ("app.js.map", b"{}"), (".well-known/assetlinks.json", b"[]")];
    s.publish(&pia, "old1", &pack(&files), "Old", "").unwrap();
    let row = s.by_label("old--app--pia").unwrap().unwrap();
    assert_eq!(row.files, 5, "index.html, .htaccess, .config/a.json, app.js, .well-known/assetlinks.json");
    let root = dir.join("sites").join(&row.id);
    for f in [".env", ".env.local", "sub/.env", "sub/tls.key", "server.pem", "credentials.json", "app.js.map"] {
        assert!(!root.join(f).exists(), "{f} was kept");
    }
    assert_eq!(s.serve("GET", "/.well-known/assetlinks.json", &row).status, 200);
    for f in ["/.htaccess", "/.config/a.json"] {
        assert_eq!(s.serve("GET", f, &row).status, 404, "{f}: a dotfile is never served");
    }
    // a version from before this fix still on the disk: serve says no all the same
    std::fs::write(root.join(".env"), "leak").unwrap();
    std::fs::write(root.join("tls.key"), "leak").unwrap();
    assert_eq!(s.serve("GET", "/.env", &row).status, 404);
    assert_eq!(s.serve("GET", "/tls.key", &row).status, 404);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_slug_is_a_dns_label_part_and_never_a_preview() {
    assert_eq!(site_slug("My Slides!"), "my-slides");
    assert_eq!(site_slug("p8080"), "p8080-app");
    assert_eq!(site_slug("!!!"), "app");
    assert!(site_slug(&"x".repeat(60)).len() <= 24);
    assert!(is_site_label("my-slides--app--pia") && !is_site_label("laptop--pia") && !is_site_label("My--app--pia"));
}

#[test]
fn an_account_has_at_most_its_apps_and_a_second_one_with_the_same_title_gets_its_own_link() {
    let (mut s, db, dir) = sites("cap");
    s.per_user = 2;
    let pia = user(&db, "u1", "pia");
    let app = pack(&[("index.html", b"x")]);
    assert_eq!(s.publish(&pia, "a", &app, "Demo", "").unwrap()["url"], "https://demo--app--pia.grid.test/");
    assert_eq!(s.publish(&pia, "b", &app, "Demo", "").unwrap()["url"], "https://demo-2--app--pia.grid.test/");
    let e = s.publish(&pia, "c", &app, "Demo", "").unwrap_err();
    assert!(e.to_string().contains("Unpublish one first"), "{e}");
    let _ = std::fs::remove_dir_all(dir);
}
