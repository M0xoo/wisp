//! v1 test/workspace.test.js: "prs: each check failing first, reviewers where they stand, comments with
//! bots marked, inline threads" and "prDetailOf / threadsOf: bots by name or type, outdated threads,
//! dismissed reviews drop out", on the fake gh's JSON.

use serde_json::{Value, json};

use super::*;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_default()).unwrap_or(Value::Null)
}

#[test]
fn the_panel_reads_a_pr_in_full() {
    let raw = fixture("review-comments.json");
    let threads = threads_of(raw.as_array().map_or(&[][..], Vec::as_slice));
    let d = pr_detail_of(&fixture("pr-detail.json"), threads, 5);
    let names: Vec<(&str, &str)> = d
        .more
        .check_list
        .iter()
        .map(|c| (c.name.as_str(), c.state.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("lint", "fail"),
            ("deploy/preview", "pending"),
            ("test (22)", "pass")
        ]
    );
    assert_eq!(d.more.check_list[2].ms, Some(65_000));
    assert_eq!(
        d.more.check_list[1].workflow, "",
        "a status has no workflow"
    );
    assert_eq!(
        d.more.check_list[0].url,
        "https://github.com/acme/repo/actions/runs/1/job/2"
    );
    assert_eq!(
        (d.pr.checks.pass, d.pr.checks.fail, d.pr.checks.pending),
        (1, 1, 1)
    );
    assert_eq!(
        d.more.reviewers,
        [Reviewer {
            author: "lena".into(),
            state: "APPROVED".into()
        }]
    );
    let notes: Vec<(&str, bool, &str)> = d
        .more
        .notes
        .iter()
        .map(|n| (n.author.as_str(), n.bot, n.kind.as_str()))
        .collect();
    assert_eq!(
        notes,
        [
            ("vercel", true, "comment"),
            ("sam", false, "comment"),
            ("lena", false, "review")
        ]
    );
    assert_eq!(d.more.threads.len(), 1);
    let who: Vec<&str> = d.more.threads[0]
        .notes
        .iter()
        .map(|n| n.author.as_str())
        .collect();
    assert_eq!(who, ["lena", "M0xoo"]);
    assert_eq!(
        (
            d.more.additions,
            d.more.deletions,
            d.more.changed_files,
            d.more.files[0].path.as_str()
        ),
        (3, 1, 1, "add.js")
    );
    assert_eq!(d.more.author, "M0xoo");
    assert_eq!(d.pr.checked_at, 5);
}

#[test]
fn the_card_copy_stays_on_the_server() {
    let d = pr_detail_of(&fixture("pr-detail.json"), Vec::new(), 0);
    let v = serde_json::to_value(&d).unwrap_or(Value::Null);
    assert!(v.get("summary").is_none());
    assert_eq!(v["number"], 1);
    assert_eq!(v["checkList"][0]["name"], "lint");
    assert_eq!(v["mergeState"], "CLEAN");
}

#[test]
fn outdated_threads_and_dismissed_reviews() {
    let th = threads_of(&[
        json!({"id": 1, "user": {"login": "a"}, "body": "x", "path": "f.js", "line": null, "original_line": 4, "position": null}),
    ]);
    assert_eq!((th[0].line, th[0].outdated), (Some(4), true));
    // no `position` at all is not outdated (v1: `c.position === null`)
    let th =
        threads_of(&[json!({"id": 1, "user": {"login": "a"}, "path": "f.js", "original_line": 4})]);
    assert!(!th[0].outdated);
    let d = pr_detail_of(
        &json!({"number": 1, "state": "OPEN", "reviews": [
            {"author": {"login": "a"}, "state": "CHANGES_REQUESTED", "body": ""},
            {"author": {"login": "a"}, "state": "DISMISSED", "body": ""},
            {"author": {"login": "b"}, "state": "PENDING", "body": "draft"}]}),
        Vec::new(),
        0,
    );
    assert!(d.more.reviewers.is_empty());
    assert!(d.more.notes.is_empty());
    assert!(d.more.check_list.is_empty());
}

#[test]
fn reviewers_keep_where_they_first_spoke() {
    let reviews = [
        json!({"author": {"login": "a"}, "state": "APPROVED"}),
        json!({"author": {"login": "b"}, "state": "CHANGES_REQUESTED"}),
        json!({"author": {"login": "a"}, "state": "CHANGES_REQUESTED"}),
        json!({"author": {"login": "c"}, "state": "COMMENTED"}),
    ];
    let refs: Vec<&Value> = reviews.iter().collect();
    let got: Vec<(String, String)> = reviewers_of(&refs)
        .into_iter()
        .map(|r| (r.author, r.state))
        .collect();
    assert_eq!(
        got,
        [
            ("a".into(), "CHANGES_REQUESTED".into()),
            ("b".into(), "CHANGES_REQUESTED".into())
        ]
    );
}

#[test]
fn replies_to_replies_join_the_root_thread() {
    let th = threads_of(&[
        json!({"id": 1, "user": {"login": "a"}, "path": "x", "line": 1}),
        json!({"id": 2, "in_reply_to_id": 1, "user": {"login": "b"}}),
        json!({"id": 3, "in_reply_to_id": 2, "user": {"login": "renovate[bot]", "type": "Bot"}}),
        json!({"id": 4, "in_reply_to_id": 99, "user": {"login": "d"}, "path": "y", "line": 9}),
    ]);
    assert_eq!(th.len(), 2);
    assert_eq!(th[0].notes.len(), 3);
    assert!(th[0].notes[2].bot);
    assert_eq!(th[1].path, "y");
}

#[test]
fn files_are_capped_and_counted() {
    let files: Vec<Value> = (0..400)
        .map(|i| json!({"path": format!("f{i}"), "additions": 1, "deletions": 0}))
        .collect();
    let d = pr_detail_of(&json!({"files": files}), Vec::new(), 0);
    assert_eq!((d.more.files.len(), d.more.changed_files), (300, 400));
}

#[test]
fn coords_of_a_pull_url() {
    assert_eq!(
        pull_coords("https://github.com/acme/repo/pull/12"),
        Some(("acme".into(), "repo".into(), 12))
    );
    assert_eq!(
        pull_coords("https://github.com/acme/repo/pull/12/files"),
        Some(("acme".into(), "repo".into(), 12))
    );
    assert_eq!(pull_coords("https://github.com/acme/repo/issues/12"), None);
    assert_eq!(pull_coords("https://gitlab.com/acme/repo/pull/12"), None);
}

/// Property: the list is always ordered fail < pending < pass < skip, and keeps every check.
#[test]
fn check_order_holds() {
    let kinds = [
        json!({"__typename": "CheckRun", "name": "n", "conclusion": "SUCCESS"}),
        json!({"__typename": "CheckRun", "name": "n", "conclusion": "SKIPPED"}),
        json!({"__typename": "CheckRun", "name": "n", "status": "QUEUED"}),
        json!({"__typename": "StatusContext", "context": "n", "state": "ERROR"}),
        json!({"__typename": "StatusContext", "state": "PENDING"}),
    ];
    let mut seed: u64 = 99;
    for _ in 0..300 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let n = usize::try_from(seed % 12).unwrap_or(0);
        let list: Vec<Value> = (0..n)
            .map(|i| {
                kinds[(usize::try_from(seed >> 20).unwrap_or(0) + i * 7) % kinds.len()].clone()
            })
            .collect();
        let out = check_list(Some(&Value::Array(list)));
        assert_eq!(out.len(), n);
        assert!(
            out.windows(2)
                .all(|w| check_rank(&w[0].state) <= check_rank(&w[1].state))
        );
    }
}
