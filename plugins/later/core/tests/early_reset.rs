//! An early (banked) reset pulls forward what waits on that plan (v1 later.js pullForward, F-auto-12): a follow-up
//! held by Automations stop at on a task of that account, and one waiting at that limit, come due now; nothing of
//! another account's, and nothing already due. The phone's note is v1's words.
#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;

use wisp_later_api::{LaterEntry, LaterHeld, LimitRef};
use wisp_later_core::rules::early_note;
use wisp_later_core::{Task, TaskState, pull_forward};

const NOW: i64 = 1_000_000;

fn task(id: &str, agent: &str, account: &str) -> (String, Task) {
    let t = Task {
        id: id.into(),
        title: id.into(),
        agent: agent.into(),
        account: account.into(),
        state: TaskState::Review,
        archived: false,
        busy: false,
        asking: false,
        delegates: false,
        sub: false,
        tour: false,
    };
    (id.into(), t)
}

fn entry(id: &str, session: &str, at: i64) -> LaterEntry {
    LaterEntry {
        id: id.into(),
        session_id: session.into(),
        at,
        text: "go on".into(),
        by: "wisp".into(),
        set_at: 0,
        remind: false,
        goal: None,
        held: None,
        limit: None,
        attachments: Vec::new(),
    }
}

#[test]
fn what_waits_on_the_plan_that_reset_early_comes_due_now_and_nothing_else() {
    let tasks: BTreeMap<String, Task> =
        [task("a", "codex", "default"), task("b", "codex", "work"), task("c", "claude", "default"), task("w", "codex", "work")].into();
    let held = LaterHeld { why: "past 75%".into(), until: NOW + 3_600_000, load: false };
    let mut on_limit = entry("limit", "a", NOW + 3_600_000);
    // later.waitAtLimit names only the harness: the task's own account
    on_limit.limit = Some(LimitRef { agent: "codex".into(), account: String::new() });
    let mut held_a = entry("held", "a", NOW + 3_600_000);
    held_a.held = Some(held.clone());
    let mut held_b = entry("other-account", "b", NOW + 3_600_000);
    held_b.held = Some(held.clone());
    let mut held_c = entry("other-harness", "c", NOW + 3_600_000);
    held_c.held = Some(held);
    let mut work_limit = entry("work-limit", "w", NOW + 3_600_000);
    work_limit.limit = Some(LimitRef { agent: "codex".into(), account: String::new() });
    let plain = entry("users-own", "a", NOW + 3_600_000);
    let entries = vec![on_limit, held_a, held_b, held_c, work_limit, plain];
    let moved = pull_forward(&entries, &tasks, "codex", "default", NOW);
    let ids: Vec<&str> = moved.iter().map(|l| l.id.as_str()).collect();
    assert_eq!(ids, ["limit", "held"]);
    assert!(moved.iter().all(|l| l.at == NOW && l.held.is_none()));
    // the work account's reset: its limit entry, never the default one's
    let moved = pull_forward(&entries, &tasks, "codex", "work", NOW);
    assert_eq!(moved.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["other-account", "work-limit"]);
    // a blank account is `default`, as everywhere
    assert_eq!(pull_forward(&entries, &tasks, "codex", "", NOW).len(), 2);
}

#[test]
fn the_phone_note_is_v1s() {
    assert_eq!(early_note("Codex", "", 0), None, "nothing waited: no note");
    assert_eq!(
        early_note("Codex", "", 1).unwrap(),
        ("\u{21bb} Codex reset early".to_owned(), "Its plan reset before its time. 1 task waiting on it starts now.".to_owned())
    );
    assert_eq!(
        early_note("Codex", "Work", 3).unwrap(),
        ("\u{21bb} Codex (Work) reset early".to_owned(), "Its plan reset before its time. 3 tasks waiting on it start now.".to_owned())
    );
}
