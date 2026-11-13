//! The words Ship it uses (v1 test/ship.test.js draft cases, routes/workspace.js logTail and check-log).

use wisp_ship_api::{PrSummary, Worktree};

use super::*;

fn input<'a>(title: &'a str, prompt: &'a str) -> DraftInput<'a> {
    DraftInput { hero_title: Some(title), hero_summary: Some("No question asked."), session_title: "s", first_prompt: prompt, markdown: "" }
}

#[test]
fn draft_is_conventional_from_the_hero_title() {
    let d = draft(&input("Fake claude finished", "fix the flaky login"));
    assert_eq!(d.title, "fix: fake claude finished");
    assert!(d.body.starts_with("No question asked."));
    assert!(d.body.ends_with("_Shipped from [wisp](https://github.com/WispAgents/wisp)._"));
    assert_eq!(draft(&input("feat(ui): already conventional", "")).title, "feat(ui): already conventional");
    assert_eq!(draft(&input("Update the README", "")).title, "docs: update the README");
    assert_eq!(draft(&input("Clean up the store", "")).title, "refactor: clean up the store");
    assert_eq!(draft(&input("Add tests for git", "")).title, "test: add tests for git");
    assert_eq!(draft(&input("Add a button", "")).title, "feat: add a button");
    assert_eq!(draft(&input("Prefix fixture", "")).title, "fix: prefix fixture", "\\bfix matches a word start, as v1's regex");
    let long = "x".repeat(300);
    assert_eq!(draft(&input(&long, "")).title.chars().count(), 100);
    let none = draft(&DraftInput { hero_title: None, session_title: "Task title", ..DraftInput::default() });
    assert_eq!(none.title, "feat: task title");
}

#[test]
fn conflict_prompt_merges_never_rebases() {
    let pr = PrSummary { number: 7, url: "https://github.com/o/r/pull/7".into(), ..PrSummary::default() };
    let wt = Worktree { base: "main".into(), branch: "wisp/x-1".into(), remote: Some("origin".into()), ..Worktree::default() };
    let p = conflict_prompt(&pr, &wt);
    assert!(p.starts_with("PR #7 (https://github.com/o/r/pull/7) can no longer merge into `main`"));
    assert!(p.contains("`git merge origin/main`. Don't rebase"));
    assert!(p.contains("`git commit --no-edit`. Don't push"));
    assert_eq!(fix_title(&wt), "Merge origin/main into wisp/x-1");
}

#[test]
fn attach_and_across_texts() {
    let pr = PrSummary { number: 3, url: "u".into(), title: "T".into(), state: "OPEN".into(), draft: true, ..PrSummary::default() };
    assert_eq!(
        attach_text(&pr, true, 1),
        "Attached PR #3 “T” (open, draft): u. It shows on the task, and wisp follows its checks and reviews. It is the PR of this task’s own branch: Ship it pushes to it."
    );
    assert!(attach_text(&pr, false, 2).ends_with("The task has 2 PRs now; attach each one you open or work on."));
    assert!(attach_text(&pr, false, 1).ends_with("checks and reviews."));
    assert_eq!(detach_text(&pr), "Detached PR #3 (u).");
    assert_eq!(across_note(&["api", "web"]), "\n\nPart of one task across `api`, `web`: wisp opens a pull request in each.");
}

#[test]
fn check_log_job_urls() {
    assert_eq!(check_log_job("https://github.com/o/r/actions/runs/123/job/456"), Some(("o".into(), "r".into(), "456".into())));
    assert_eq!(check_log_job("https://github.com/o/r/actions/runs/123/job/456?pr=9").map(|j| j.2), Some("456".into()));
    for bad in [
        "https://github.com/o/r/pull/1",
        "https://evil.com/o/r/actions/runs/1/job/2",
        "https://github.com/o/r/actions/runs/x/job/2",
        "https://github.com/o/r/actions/runs/1",
    ] {
        assert_eq!(check_log_job(bad), None, "{bad}");
    }
    assert_eq!(repo_of_url("https://github.com/acme/docs/pull/9"), "docs");
    assert_eq!(repo_of_url("https://example.com/x"), "");
}

#[test]
fn log_tail_keeps_the_text_and_the_last_lines() {
    let out = "build\tRun tests\t2026-11-08T10:00:00.1234567Z first\nbuild\tRun tests\t2026-11-08T10:00:01Z \x1b[31mred\x1b[0m\n\n\n\nbuild\tRun tests\t2026-11-08T10:00:02Z last";
    assert_eq!(log_tail(out, LOG_LINES), "first\nred\n\nlast");
    assert_eq!(log_tail(out, 1), "last");
    assert_eq!(log_tail("\u{feff}2026-01-01T00:00:00Z plain", 5), "plain");
    assert_eq!(log_tail("no tabs here", 5), "no tabs here");
    assert_eq!(log_tail("", 5), "");
}

#[test]
fn the_pr_body_keeps_prose_callouts_steps_and_files_from_the_answer_but_not_its_hero_or_code() {
    let blocks = vec![
        serde_json::json!({ "type": "hero", "title": "Login now rate-limited", "summary": "5 tries a minute." }),
        serde_json::json!({ "type": "markdown", "text": "Uses a sliding window." }),
        serde_json::json!({ "type": "code", "code": "let x = 1;" }),
        serde_json::json!({ "type": "callout", "title": "Assumption", "text": "Behind a proxy." }),
        serde_json::json!({ "type": "steps", "items": [{ "title": "Added limiter", "detail": "src/a.ts" }, { "title": "Tests" }] }),
        serde_json::json!({ "type": "next", "items": ["ship"] }),
    ];
    let (title, summary, md) = super::presentation_parts(&blocks);
    assert_eq!(title, Some("Login now rate-limited"));
    assert_eq!(summary, Some("5 tries a minute."));
    assert_eq!(md, "Uses a sliding window.\n\n> **Assumption** Behind a proxy.\n\n- Added limiter: src/a.ts\n- Tests");
    let none = super::presentation_parts(&[]);
    assert_eq!((none.0, none.1, none.2.as_str()), (None, None, ""));
}
