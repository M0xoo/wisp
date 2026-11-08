//! v1's test/review.test.js, case by case. The git-backed diffSections cases run on parsed `FileDiff`s
//! (the shape git.service hands over); constraintsOf's extraction is handoff's and tested there.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    clippy::range_plus_one,
    clippy::format_push_string,
    clippy::needless_pass_by_value,
    clippy::needless_lifetimes,
    clippy::elidable_lifetime_names,
    clippy::option_option,
    clippy::doc_markdown,
    clippy::map_unwrap_or,
    clippy::format_collect
)]

use serde_json::{Value, json};
use wisp_git_api::{FileDiff, Row};
use wisp_review_api::{
    Coverage, Finding, HARNESSES, Pick, REVIEW_VALUES, Review, Severity, Status, TestsRun,
};
use wisp_review_core::*;

fn agents(ids: &[&str]) -> Vec<Agent> {
    ids.iter()
        .map(|id| Agent {
            id: (*id).into(),
            name: if *id == "codex" {
                "Codex".into()
            } else {
                (*id).into()
            },
            available: true,
        })
        .collect()
}
fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}
fn pick(a: &str) -> Pick {
    Pick {
        agent: a.into(),
        model: String::new(),
    }
}

#[test]
fn another_harness_than_the_author_in_a_fixed_order() {
    assert_eq!(
        pick_reviewer("other", &s(&["claude"]), &agents(&["claude", "codex"])),
        Ok(pick("codex"))
    );
    assert_eq!(
        pick_reviewer("other", &s(&["codex"]), &agents(&["claude", "codex"])),
        Ok(pick("claude"))
    );
    assert_eq!(
        pick_reviewer(
            "other",
            &s(&["claude", "codex"]),
            &agents(&["claude", "codex", "copilot"])
        ),
        Ok(pick("copilot"))
    );
    assert!(
        pick_reviewer("other", &s(&["claude"]), &agents(&["claude"]))
            .unwrap_err()
            .contains("No other harness")
    );
    let off = vec![
        Agent {
            id: "claude".into(),
            name: String::new(),
            available: true,
        },
        Agent {
            id: "codex".into(),
            name: String::new(),
            available: false,
        },
    ];
    assert!(
        pick_reviewer("other", &s(&["claude"]), &off)
            .unwrap_err()
            .contains("No other harness")
    );
}

#[test]
fn a_picked_harness_reviews_even_its_own_work_off_and_missing_say_why() {
    assert_eq!(
        pick_reviewer("claude", &s(&["claude"]), &agents(&["claude", "codex"])),
        Ok(pick("claude"))
    );
    let missing = vec![Agent {
        id: "codex".into(),
        name: "Codex".into(),
        available: false,
    }];
    assert_eq!(
        pick_reviewer("codex", &s(&["claude"]), &missing).unwrap_err(),
        "Codex isn't installed here."
    );
    assert!(
        pick_reviewer("off", &[], &agents(&["claude"]))
            .unwrap_err()
            .contains("off")
    );
}

#[test]
fn authors_are_the_turns_harnesses_not_auto_or_wisp() {
    assert_eq!(
        authors_of("auto", ["claude", "codex", "claude"]),
        s(&["claude", "codex"])
    );
    assert_eq!(authors_of("codex", [""]), s(&["codex"]));
    assert_eq!(authors_of("wisp", ["wisp"]), Vec::<String>::new());
}

#[test]
fn a_reply_becomes_findings_high_first_junk_is_none() {
    let (summary, f) = read_review(&json!({ "summary": "s", "findings": [{ "severity": "low", "text": "nit" }, { "severity": "high", "file": "a.js", "line": "12", "text": "bug" }, { "text": "" }, { "severity": "odd", "text": "x", "line": -1 }] }), &[]).unwrap();
    assert_eq!(summary, "s");
    assert_eq!(
        serde_json::to_value(&f).unwrap(),
        json!([{ "severity": "high", "file": "a.js", "line": 12, "text": "bug" }, { "severity": "medium", "text": "x" }, { "severity": "low", "text": "nit" }])
    );
    assert_eq!(
        read_review(&json!({ "findings": [] }), &[]).unwrap().0,
        "Nothing to fix."
    );
    assert_eq!(
        read_review(&json!({ "findings": [{"text": "a"}, {"text": "b"}] }), &[])
            .unwrap()
            .0,
        "2 issues found."
    );
    assert!(read_review(&Value::Null, &[]).is_none());
    assert!(read_review(&json!({ "summary": "no list" }), &[]).is_none());
    let many: Vec<Value> = (0..40).map(|_| json!({ "text": "x" })).collect();
    assert_eq!(
        read_review(&json!({ "findings": many }), &[])
            .unwrap()
            .1
            .len(),
        20
    );
}

#[test]
fn the_prompt_carries_the_diff_and_the_tests_the_view_says_if_it_is_of_the_head() {
    let t = TestsRun {
        verdict: "fail".into(),
        command: "npm test".into(),
        output: "boom".into(),
        ..TestsRun::default()
    };
    let p = review_prompt(&PromptInput {
        title: "fix \"add\"",
        task: "Fix add",
        diff: "+a",
        tests: Some(&t),
        ..PromptInput::default()
    });
    assert!(p.contains("You review a pull request another coding agent wrote"));
    assert!(p.contains("<pr title=\"fix 'add'\">\nFix add\n</pr>"));
    assert!(p.contains("<tests command=\"npm test\" verdict=\"fail\">\nboom"));
    assert!(p.contains("<diff>\n+a\n</diff>"));
    let skip = TestsRun {
        verdict: "skip".into(),
        ..TestsRun::default()
    };
    assert!(
        !review_prompt(&PromptInput {
            tests: Some(&skip),
            ..PromptInput::default()
        })
        .contains("<tests")
    );
    let pass = TestsRun {
        verdict: "pass".into(),
        command: "t".into(),
        output: "noise".into(),
        ..TestsRun::default()
    };
    assert!(
        review_prompt(&PromptInput {
            tests: Some(&pass),
            ..PromptInput::default()
        })
        .contains("<tests command=\"t\" verdict=\"pass\"></tests>")
    );
    let r = Review {
        status: Status::Done,
        head: "abc".into(),
        at: 1,
        ..Review::default()
    };
    assert!(review_view(Some(&r), Some("abc")).unwrap().current);
    assert!(!review_view(Some(&r), Some("def")).unwrap().current);
    assert!(review_view(None, Some("abc")).is_none());
}

#[test]
fn the_prompt_carries_the_constraints_and_done_when_none_no_block() {
    let c = constraints_for(
        s(&[
            "Don't touch migrations/, they are shared with prod.",
            "only change web/ and server/auth",
        ]),
        "logging in   lands on /home",
    );
    assert_eq!(
        c,
        s(&[
            "Don't touch migrations/, they are shared with prod.",
            "only change web/ and server/auth",
            "Done when: logging in lands on /home"
        ])
    );
    let p = review_prompt(&PromptInput {
        diff: "+a",
        constraints: &c,
        ..PromptInput::default()
    });
    assert!(p.contains("Touched migrations/ — you said: don't touch migrations"));
    assert!(p.contains("\n1. Don't touch migrations/, they are shared with prod.\n2. only change web/ and server/auth\n3. Done when: logging in lands on /home\n</constraints>"));
    assert!(p.contains("\"constraint\": 1"));
    assert!(p.find("<constraints>") < p.find("<diff>"));
    assert_eq!(constraints_for(vec![], ""), Vec::<String>::new());
    let plain = review_prompt(&PromptInput {
        diff: "+a",
        ..PromptInput::default()
    });
    assert!(!plain.contains("<constraints>") && !plain.contains("\"constraint\""));
    // a long Done when is clipped at 600
    assert_eq!(
        constraints_for(vec![], &"w ".repeat(400))[0]
            .chars()
            .count(),
        "Done when: ".len() + 600
    );
}

#[test]
fn a_finding_that_breaks_a_constraint_is_high_and_carries_the_users_words() {
    let c = s(&["Don't touch migrations/", "Done when: login works"]);
    let (_, f) = read_review(
        &json!({ "summary": "s", "findings": [
            { "severity": "low", "file": "src/a.js", "text": "nit" },
            { "severity": "medium", "file": "migrations/004_users.sql", "line": 3, "text": "Touched migrations/ — you said: don’t touch migrations", "constraint": 1 },
            { "severity": "low", "text": "made up", "constraint": 9 },
            { "severity": "low", "text": "not a number", "constraint": "one" },
        ] }),
        &c,
    )
    .unwrap();
    assert_eq!(
        f[0],
        Finding {
            severity: Severity::High,
            file: Some("migrations/004_users.sql".into()),
            line: Some(3),
            text: "Touched migrations/ — you said: don’t touch migrations".into(),
            constraint: Some(1),
            rule: Some("Don't touch migrations/".into())
        }
    );
    assert!(
        f[1..]
            .iter()
            .all(|x| x.severity == Severity::Low && x.constraint.is_none() && x.rule.is_none())
    );
    // without constraints sent, a constraint number means nothing
    assert_eq!(
        read_review(
            &json!({ "findings": [{ "severity": "low", "text": "x", "constraint": 1 }] }),
            &[]
        )
        .unwrap()
        .1[0]
            .severity,
        Severity::Low
    );
    let r = Review {
        status: Status::Done,
        head: "h".into(),
        findings: f,
        constraints: c.clone(),
        at: 1,
        ..Review::default()
    };
    assert_eq!(review_view(Some(&r), Some("h")).unwrap().constraints, c);
    let bare = Review {
        status: Status::Done,
        head: "h".into(),
        at: 1,
        ..Review::default()
    };
    assert!(
        serde_json::to_value(review_view(Some(&bare), Some("h")))
            .unwrap()
            .get("constraints")
            .is_none()
    );
}

#[test]
fn the_settings_values() {
    assert_eq!(REVIEW_VALUES[..2], ["off", "other"]);
    assert_eq!(&REVIEW_VALUES[2..], HARNESSES);
}

/// A file's section as `git diff` prints it, with hunks of the given sizes.
fn section(p: &str, hunks: &[usize]) -> Section {
    let mut text = format!("diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n");
    for (i, n) in hunks.iter().enumerate() {
        text.push_str(&format!("@@ -{i},1 +{i},1 @@\n+{}\n", "x".repeat(*n)));
    }
    Section {
        path: p.into(),
        text,
        cut: false,
    }
}
fn paths(v: &[Section]) -> Vec<String> {
    v.iter().map(|x| x.path.clone()).collect()
}

#[test]
fn fit_everything_fits_nothing_left_out_sections_whole() {
    let (a, b) = (section("a.js", &[10]), section("b.js", &[10]));
    let (diff, c) = fit_diff(&[a.clone(), b.clone()], &s(&["a.js", "b.js"]), MAX_DIFF);
    assert_eq!(diff, format!("{}{}", a.text, b.text));
    let n = diff.chars().count() as u64;
    assert_eq!(
        c,
        Coverage {
            files: 2,
            seen: 2,
            chars: n,
            seen_chars: n,
            cut: vec![],
            missing: vec![],
            more: None
        }
    );
}

#[test]
fn fit_a_file_that_does_not_fit_is_skipped_not_the_end() {
    let small = |i: u32| section(&format!("s{i}.js"), &[50]);
    let huge = Section {
        path: "lock.json".into(),
        text: format!(
            "diff --git a/lock.json b/lock.json\nBinary-ish, no hunks {}\n",
            "x".repeat(5000)
        ),
        cut: false,
    };
    let all = vec![small(1), huge, small(2), small(3)];
    let (diff, c) = fit_diff(&all, &paths(&all), 1000);
    for x in [small(1), small(2), small(3)] {
        assert!(diff.contains(&x.text));
    }
    assert!(!diff.contains("lock.json"));
    assert_eq!(c.seen, 3);
    assert_eq!(c.missing, s(&["lock.json"]));
    assert_eq!(c.seen_chars, diff.chars().count() as u64);
    assert!(c.chars > c.seen_chars);
}

#[test]
fn fit_one_oversized_file_is_cut_on_a_hunk_boundary() {
    let big = section("big.js", &[400, 400, 5000, 100]);
    let (diff, c) = fit_diff(&[big], &s(&["big.js"]), 1100);
    assert!(diff.chars().count() <= 1100);
    assert!(diff.starts_with("diff --git a/big.js b/big.js\n--- a/big.js\n+++ b/big.js\n@@ -0,1"));
    let heads: Vec<&str> = diff
        .lines()
        .filter(|l| l.starts_with("@@ -"))
        .map(|l| &l[..5])
        .collect();
    assert_eq!(heads, ["@@ -0", "@@ -1", "@@ -3"]);
    assert!(diff.ends_with(&format!("+{}\n", "x".repeat(100))));
    assert_eq!((c.seen, c.cut, c.missing), (0, s(&["big.js"]), vec![]));
}

#[test]
fn fit_no_hunk_fits_nothing_of_the_file_not_its_header_alone() {
    let (diff, c) = fit_diff(&[section("big.js", &[5000])], &s(&["big.js"]), 1000);
    assert_eq!(diff, "");
    assert_eq!((c.seen, c.cut, c.missing), (0, vec![], s(&["big.js"])));
}

#[test]
fn fit_a_new_file_already_cut_counts_as_cut_even_when_it_fits() {
    let x = Section {
        path: "new.js".into(),
        text: "\n--- /dev/null\n+++ b/new.js\n+a".into(),
        cut: true,
    };
    let (diff, c) = fit_diff(&[x], &s(&["new.js"]), MAX_DIFF);
    assert!(diff.contains("new.js"));
    assert_eq!((c.seen, c.cut), (0, s(&["new.js"])));
}

#[test]
fn fit_at_most_50_names_and_more_counts_the_rest() {
    let names = |n: usize, at: &str| (0..n).map(|i| format!("{at}{i}.js")).collect::<Vec<_>>();
    let cut: Vec<Section> = names(10, "c")
        .into_iter()
        .map(|p| Section {
            path: p,
            text: "x".into(),
            cut: true,
        })
        .collect();
    let files = [names(10, "c"), names(60, "m")].concat();
    let (_, c) = fit_diff(&cut, &files, MAX_DIFF);
    assert_eq!(
        (c.cut.len(), c.missing.len(), c.more, c.files),
        (10, 40, Some(20), 70)
    );
    let (_, c) = fit_diff(&[], &names(50, "m"), MAX_DIFF);
    assert!(serde_json::to_value(&c).unwrap().get("more").is_none());
}

#[test]
fn fit_a_path_with_two_sections_is_seen_only_if_both_are() {
    let twice = vec![section("a.js", &[10]), section("a.js", &[5000])];
    let (_, c) = fit_diff(&twice, &s(&["a.js"]), 1000);
    assert_eq!((c.files, c.seen, c.cut), (1, 0, s(&["a.js"])));
}

#[test]
fn a_diff_git_would_not_give_reads_0_seen_never_no_changes() {
    let (diff, c) = fit_diff(&[], &s(&["a.js", "b.js"]), MAX_DIFF);
    assert_eq!(diff, "");
    assert_eq!(
        (c.files, c.seen, c.missing.clone()),
        (2, 0, s(&["a.js", "b.js"]))
    );
    let p = review_prompt(&PromptInput {
        diff: &diff,
        coverage: Some(&c),
        ..PromptInput::default()
    });
    assert!(!p.contains("(no changes)"));
    assert!(p.contains("holds 0 of 2 files whole"));
    let (_, none) = fit_diff(&[], &[], MAX_DIFF);
    assert!(
        review_prompt(&PromptInput {
            coverage: Some(&none),
            ..PromptInput::default()
        })
        .contains("(no changes)")
    );
}

#[test]
fn the_prompt_says_when_the_diff_is_partial_before_the_diff() {
    let c = Coverage {
        files: 63,
        seen: 41,
        chars: 90000,
        seen_chars: 60000,
        cut: s(&["a.js"]),
        missing: s(&["b.js", "c.js"]),
        more: Some(19),
    };
    let p = review_prompt(&PromptInput {
        diff: "+a",
        coverage: Some(&c),
        ..PromptInput::default()
    });
    assert!(p.find("<partial>") < p.find("<diff>"));
    assert!(p.contains("holds 41 of 63 files whole"));
    assert!(p.contains("Only part of: a.js\nNot in it: b.js, c.js\nAnd 19 files not named here."));
    assert!(p.contains("working directory") && p.contains("covers only what you read"));
    let whole = Coverage {
        files: 2,
        seen: 2,
        chars: 2,
        seen_chars: 2,
        ..Coverage::default()
    };
    assert!(
        !review_prompt(&PromptInput {
            diff: "+a",
            coverage: Some(&whole),
            ..PromptInput::default()
        })
        .contains("<partial>")
    );
}

#[test]
fn the_summary_of_a_partial_review_with_no_findings_is_wisps_own() {
    let c = |seen, cut: &[&str]| Coverage {
        files: 63,
        seen,
        cut: s(cut),
        ..Coverage::default()
    };
    assert_eq!(
        partial_summary(&c(41, &["a.js"])),
        "No issues in what it read."
    );
    assert_eq!(
        partial_summary(&c(0, &["big.js"])),
        "No issues in the part it read."
    );
    assert_eq!(
        partial_summary(&c(0, &["a.js", "b.js", "c.js"])),
        "No issues in the parts it read."
    );
    assert_eq!(
        partial_summary(&c(0, &[])),
        "No issues found, but it read nothing."
    );
}

#[test]
fn the_view_passes_coverage_through_an_old_review_reads_as_it_did() {
    let r = Review {
        status: Status::Done,
        head: "abc".into(),
        summary: Some("Fine".into()),
        at: 1,
        ..Review::default()
    };
    assert_eq!(
        serde_json::to_value(review_view(Some(&r), Some("abc"))).unwrap(),
        json!({ "status": "done", "head": "abc", "current": true, "summary": "Fine", "findings": [], "at": 1 })
    );
    let cov = Coverage {
        files: 2,
        seen: 1,
        chars: 9,
        seen_chars: 4,
        missing: s(&["b.js"]),
        ..Coverage::default()
    };
    let r = Review {
        coverage: Some(cov.clone()),
        ..r
    };
    assert_eq!(
        review_view(Some(&r), Some("abc")).unwrap().coverage,
        Some(cov)
    );
}

// ---- diffSections on parsed files ----

fn row(op: char, text: &str, a: Option<u32>, b: Option<u32>) -> Row {
    Row {
        op,
        text: Some(text.into()),
        a,
        b,
        count: None,
    }
}
fn file(path: &str, status: char, rows: Vec<Row>) -> FileDiff {
    // through serde: git.service may add optional fields without breaking this
    serde_json::from_value(json!({ "path": path, "status": status, "add": 0, "del": 0, "binary": false, "rows": rows, "more": 0 })).unwrap()
}

#[test]
fn sections_one_per_file_renames_spaces_and_non_ascii_read_right() {
    let renamed = FileDiff {
        from: Some("old name.js".into()),
        ..file("new name.js", 'R', vec![])
    };
    let spaced = file(
        "a b.js",
        'M',
        vec![
            row(' ', "1", Some(1), Some(1)),
            row('+', "diff --git a/fake b/fake", None, Some(2)),
        ],
    );
    let accent = file("é.js", 'M', vec![row('+', "2\r", None, Some(2))]);
    let (sections, files) = sections_of(&[renamed, spaced, accent]);
    assert_eq!(files, s(&["new name.js", "a b.js", "é.js"]));
    for x in &sections {
        assert_eq!(section_path(&x.text), x.path, "{}", x.text);
    }
    assert_eq!(fit_diff(&sections, &files, MAX_DIFF).1.seen, 3);
    // a line that looks like a header stays inside its hunk
    assert!(sections[1].text.contains("\n+diff --git a/fake b/fake\n"));
    assert_eq!(
        split_at(
            &sections.iter().map(|x| x.text.clone()).collect::<String>(),
            "diff --git "
        )
        .len(),
        3
    );
}

#[test]
fn sections_new_files_cut_by_git_count_as_cut_and_node_modules_is_no_change() {
    let big = FileDiff {
        more: 10,
        ..file("z.txt", 'A', vec![row('+', "y", None, Some(1))])
    };
    let nm = file("node_modules", 'A', vec![row('+', "x", None, Some(1))]);
    let (sections, files) = sections_of(&[big, nm]);
    assert_eq!(files, s(&["z.txt"]));
    assert!(sections[0].cut);
    assert!(
        sections[0]
            .text
            .contains("--- /dev/null\n+++ b/z.txt\n@@ -0,0 +1,1 @@\n+y\n")
    );
}

#[test]
fn section_path_reads_v1_headers() {
    assert_eq!(
        section_path("diff --git a/x/y.js b/x/y.js\n--- a"),
        "x/y.js"
    );
    assert_eq!(section_path("diff --git x.js x.js\n"), "x.js"); // diff.noprefix
    assert_eq!(
        section_path("diff --git a/o b/n\nsimilarity index 90%\nrename from o\nrename to n\n"),
        "n"
    );
    assert_eq!(
        section_path("diff --git \"a/t\\tb\" \"b/t\\tb\"\n"),
        "t\\tb"
    );
}

// ---- the state machine ----

fn due<'a>(last: Option<&'a Review>) -> Due<'a> {
    Due {
        has_worktree: true,
        pr_open: true,
        pr_head: "h1",
        setting: "other",
        last,
        ..Due::default()
    }
}

#[test]
fn gate_refuses_without_an_open_pr_of_its_own_branch() {
    for d in [
        Due {
            has_worktree: false,
            ..due(None)
        },
        Due {
            is_child: true,
            ..due(None)
        },
        Due {
            pr_open: false,
            ..due(None)
        },
        Due {
            pr_head: "",
            ..due(None)
        },
    ] {
        assert_eq!(gate(&d), Gate::Refuse(machine::NO_PR.into()));
    }
    assert_eq!(
        gate(&Due {
            setting: "off",
            ..due(None)
        }),
        Gate::Refuse(machine::OFF.into())
    );
    // forced while off: another harness than the author
    assert_eq!(
        gate(&Due {
            setting: "off",
            force: true,
            ..due(None)
        }),
        Gate::Pick {
            setting: "other".into()
        }
    );
}

#[test]
fn gate_is_quiet_while_running_or_reviewed_and_waits_for_the_run() {
    assert_eq!(
        gate(&Due {
            running: Some("h1"),
            busy: true,
            ..due(None)
        }),
        Gate::Quiet
    );
    assert_eq!(
        gate(&Due {
            running: Some("h0"),
            busy: true,
            ..due(None)
        }),
        Gate::Refuse(machine::BUSY.into())
    );
    let done = Review {
        status: Status::Done,
        head: "h1".into(),
        ..Review::default()
    };
    assert_eq!(gate(&due(Some(&done))), Gate::Quiet);
    assert_eq!(
        gate(&Due {
            force: true,
            ..due(Some(&done))
        }),
        Gate::Pick {
            setting: "other".into()
        }
    );
    let old = Review {
        head: "h0".into(),
        ..done.clone()
    };
    assert_eq!(
        gate(&Due {
            setting: "codex",
            ..due(Some(&old))
        }),
        Gate::Pick {
            setting: "codex".into()
        }
    );
    // a running record of this head left by a crash is reviewed again
    let stale = Review {
        status: Status::Running,
        ..done
    };
    assert!(matches!(gate(&due(Some(&stale))), Gate::Pick { .. }));
}

#[test]
fn after_pick_fails_holds_or_starts() {
    match after_pick("h", Err("No other harness".into()), None, 5) {
        Decision::Stop { review, why } => assert_eq!(
            (
                review.status,
                review.why.as_deref(),
                why.as_str(),
                review.at
            ),
            (
                Status::Failed,
                Some("No other harness"),
                "No other harness",
                5
            )
        ),
        Decision::Start { .. } => unreachable!(),
    }
    match after_pick(
        "h",
        Ok(pick("codex")),
        Some("Codex is past stop at".into()),
        5,
    ) {
        Decision::Stop { review, .. } => assert_eq!(
            (review.status, review.by),
            (Status::Held, Some(pick("codex")))
        ),
        Decision::Start { .. } => unreachable!(),
    }
    match after_pick("h", Ok(pick("codex")), None, 5) {
        Decision::Start { review, pick: p } => assert_eq!(
            (review.status, review.head.as_str(), p),
            (Status::Running, "h", pick("codex"))
        ),
        Decision::Stop { .. } => unreachable!(),
    }
}

#[test]
fn finish_records_done_failed_and_a_partial_summary() {
    let p = pick("codex");
    let t = TestsRun {
        verdict: "pass".into(),
        command: "npm test".into(),
        passed: 3,
        ..TestsRun::default()
    };
    let partial = Coverage {
        files: 2,
        seen: 1,
        cut: vec![],
        missing: s(&["b"]),
        ..Coverage::default()
    };
    let f = |cov: Option<Coverage>| Finish {
        head: "h",
        pick: &p,
        tests: Some(&t),
        constraints: vec![],
        coverage: cov,
        now: 9,
    };
    let r = finish(
        f(Some(partial.clone())),
        Outcome::Answered {
            summary: "Nothing to fix.".into(),
            findings: vec![],
        },
    );
    assert_eq!(
        (
            r.status,
            r.summary.as_deref(),
            r.tests.as_ref().map(|t| t.passed)
        ),
        (Status::Done, Some("No issues in what it read."), Some(3))
    );
    let r = finish(
        f(None),
        Outcome::Silent {
            reviewer: "Codex".into(),
        },
    );
    assert_eq!(
        (r.status, r.why.as_deref()),
        (Status::Failed, Some("Codex didn’t answer."))
    );
    let r = finish(
        f(Some(partial)),
        Outcome::Error {
            why: "x".repeat(400),
        },
    );
    assert_eq!(
        (r.status, r.why.unwrap().chars().count(), r.tests),
        (Status::Failed, 300, None)
    );
    let skip = TestsRun {
        verdict: "skip".into(),
        ..TestsRun::default()
    };
    assert_eq!(tests_summary(Some(&skip)), None);
}

#[test]
fn a_review_cut_short_by_a_restart_starts_over() {
    assert_eq!(
        on_boot(Some(Review {
            status: Status::Running,
            ..Review::default()
        })),
        None
    );
    assert!(
        on_boot(Some(Review {
            status: Status::Held,
            ..Review::default()
        }))
        .is_some()
    );
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn property_fit_never_exceeds_the_budget_never_cuts_mid_hunk_and_accounts_for_every_file() {
    let mut r = Rng(0xdead_beef);
    for _ in 0..300 {
        let n = r.below(12) as usize;
        let mut secs: Vec<Section> = (0..n)
            .map(|i| {
                let hunks: Vec<usize> = (0..r.below(5)).map(|_| r.below(800) as usize).collect();
                section(&format!("f{}.js", i % 9), &hunks)
            })
            .collect();
        if r.below(3) == 0 {
            secs.push(Section {
                path: "cut.js".into(),
                text: format!(
                    "diff --git a/cut.js b/cut.js\n{}",
                    "x".repeat(r.below(300) as usize)
                ),
                cut: true,
            });
        }
        let extra: Vec<String> = (0..r.below(70)).map(|i| format!("m{i}.js")).collect();
        let files = [paths(&secs), extra].concat();
        let max = 200 + r.below(3000) as usize;
        let (diff, c) = fit_diff(&secs, &files, max);
        assert!(diff.chars().count() <= max);
        assert_eq!(c.seen_chars, diff.chars().count() as u64);
        // every hunk header in the result is followed by its whole line
        let pieces: Vec<String> = split_at(&diff, "diff --git ")
            .iter()
            .flat_map(|file| split_at(file, "@@ ").into_iter().skip(1))
            .collect();
        for piece in &pieces {
            assert!(
                secs.iter().any(|x| x.text.contains(piece)),
                "a hunk was cut: {piece:?}"
            );
        }
        assert!(c.cut.len() + c.missing.len() <= MAX_NAMES);
        let named = c.seen as usize + c.cut.len() + c.missing.len() + c.more.unwrap_or(0) as usize;
        assert_eq!(named, c.files as usize);
    }
}

#[test]
fn property_read_review_never_keeps_more_than_20_and_sorts_by_severity() {
    let mut r = Rng(99);
    let sev = [
        json!("high"),
        json!("medium"),
        json!("low"),
        json!("odd"),
        Value::Null,
    ];
    for _ in 0..200 {
        let list: Vec<Value> = (0..r.below(40)).map(|_| json!({ "severity": sev[r.below(5) as usize].clone(), "text": if r.below(5) == 0 { "" } else { "t" }, "line": r.below(5) as i64 - 2, "constraint": r.below(4) })).collect();
        let c = s(&["a", "b"]);
        let (_, f) = read_review(&json!({ "findings": list }), &c).unwrap();
        assert!(f.len() <= MAX_FINDINGS);
        assert!(f.windows(2).all(|w| w[0].severity <= w[1].severity));
        assert!(f.iter().all(|x| x.line.is_none_or(|l| l > 0)));
        assert!(
            f.iter()
                .all(|x| x.rule.is_none() || x.severity == Severity::High)
        );
    }
}
