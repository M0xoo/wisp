//! FTS5 search: words and prefixes, follows patches and deletes, user text is never syntax (search.test.ts).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty, clippy::unnecessary_wraps)]

mod common;

use common::{event, open, open_disk, session_with};
use serde_json::json;
use wisp_store::{PatchOp, StoreError, to_match};

fn ids(store: &wisp_store::Store, q: &str) -> Vec<String> {
    let mut v: Vec<_> = store.search(q, None, 50).unwrap().into_iter().map(|h| h.id).collect();
    v.sort();
    v
}

#[test]
fn search_finds_rows_by_words_and_prefix_and_follows_patches_and_deletes() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session_with("a", json!({"title": "Fix the login rate limiter"})))?;
            w.upsert("session", session_with("b", json!({"title": "Rate card for pricing"})))
        })
        .unwrap();
    f.store.define_search("session", &["title"]).unwrap();
    assert_eq!(ids(&f.store, "rate"), vec!["a", "b"], "rows that existed before the index are indexed");
    assert_eq!(ids(&f.store, "login lim"), vec!["a"], "every word, the last as a prefix");
    f.store.write_blocking(|w| w.patch("session", "b", &[PatchOp::replace(&["title"], json!("Pricing page"))])).unwrap();
    assert_eq!(ids(&f.store, "rate"), vec!["a"]);
    assert_eq!(ids(&f.store, "pricing"), vec!["b"]);
    f.store.write_blocking(|w| w.del("session", "a")).unwrap();
    assert_eq!(ids(&f.store, "login"), Vec::<String>::new());
    f.store.write_blocking(|w| w.upsert("session", session_with("c", json!({"title": "login again"})))).unwrap();
    assert_eq!(ids(&f.store, "login"), vec!["c"]);
}

#[test]
fn query_syntax_in_what_someone_types_is_text_never_an_fts5_error() {
    let f = open();
    f.store.define_search("session", &["title", "extra"]).unwrap();
    f.store
        .write_blocking(|w| w.upsert("session", session_with("a", json!({"title": "NOT \"quoted\" a-b:c", "extra": {"note": "AND OR"}}))))
        .unwrap();
    for q in ["\"", "a-b:c", "NOT", "(", "*", "AND OR", "quoted\"", "", "NEAR(a b)", "title:x", "^x"] {
        assert!(f.store.search(q, None, 50).is_ok(), "{q}");
    }
    assert_eq!(ids(&f.store, "quoted"), vec!["a"]);
    assert_eq!(ids(&f.store, "note"), vec!["a"], "json columns are indexed as their text");
    assert_eq!(to_match("  say \"hi\"  "), "\"say\" \"\"\"hi\"\"\"*");
}

#[test]
fn a_rolled_back_write_leaves_the_index_as_it_was_and_the_index_survives_reopen() {
    let f = open_disk(None);
    f.store.define_search("session", &["title"]).unwrap();
    f.store.write_blocking(|w| w.upsert("session", session_with("a", json!({"title": "alpha"})))).unwrap();
    let out: Result<(), _> = f.store.write_blocking(|w| {
        w.patch("session", "a", &[PatchOp::replace(&["title"], json!("beta"))])?;
        Err(StoreError::Internal("no".into()))
    });
    assert!(out.is_err());
    assert_eq!(ids(&f.store, "alpha"), vec!["a"]);
    assert_eq!(ids(&f.store, "beta"), Vec::<String>::new());
    let home = f.home.clone();
    f.store.close();
    drop(f);
    let g = open_disk(home);
    g.store.define_search("session", &["title"]).unwrap();
    assert_eq!(ids(&g.store, "alpha"), vec!["a"]);
    g.store.define_search("session", &["title", "state"]).unwrap();
    assert_eq!(ids(&g.store, "idle"), vec!["a"], "a new column list rebuilds the index");
}

#[test]
fn search_across_kinds_limited_and_refusing_a_kind_with_no_index() {
    let f = open();
    f.store.define_search("session", &["title"]).unwrap();
    f.store.define_search("event", &["body"]).unwrap();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session_with("a", json!({"title": "deploy grid"})))?;
            w.append("event", vec![event("a", 1, "text", json!({"text": "deploy finished"}))])
        })
        .unwrap();
    let mut kinds: Vec<_> = f.store.search("deploy", None, 50).unwrap().into_iter().map(|h| h.kind).collect();
    kinds.sort();
    assert_eq!(kinds, vec!["event", "session"]);
    assert_eq!(f.store.search("deploy", None, 1).unwrap().len(), 1);
    assert_eq!(f.store.search("deploy", Some(&["event"]), 50).unwrap()[0].id, "1");
    assert!(f.store.search("x", Some(&["plugin"]), 50).unwrap_err().to_string().contains("no search index"));
    assert!(f.store.define_search("session", &["nope"]).is_err());
}
