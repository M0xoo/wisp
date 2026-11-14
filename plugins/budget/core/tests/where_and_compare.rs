//! Plan budget past the windows (v1 budget.js `whereItWent`, `compareAccounts`, F-acct-11, F-acct-14): where an
//! account's longest window went this period, kept across a restart; and tokens per turn by account.
#![allow(clippy::unwrap_used, clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use wisp_budget_api::{LimitWindow, LimitsReport};
use wisp_budget_core::Budget;
use wisp_budget_core::traced::{TurnSample, top};

const H: i64 = 3_600_000;

fn report(five: f64, week: f64, week_reset: i64) -> LimitsReport {
    LimitsReport {
        windows: vec![
            LimitWindow { id: "five_hour".into(), used: five, resets_at: Some(5 * H), ms: Some(5 * H), slot: None },
            LimitWindow { id: "seven_day".into(), used: week, resets_at: Some(week_reset), ms: Some(7 * 24 * H), slot: None },
        ],
        ..LimitsReport::default()
    }
}

#[test]
fn where_your_plan_went_shares_the_longest_window_among_tasks_this_period() {
    let mut b = Budget::new();
    let week = 100 * H;
    b.record("claude", "default", &report(0.0, 0.10, week), 1_000);
    b.begin("claude", "default", "task-a", "a1", 1_000);
    b.begin("claude", "default", "task-b", "b1", 1_000);
    b.record("claude", "default", &report(0.2, 0.30, week), 61_000);
    b.end("task-b", "b1", 61_000);
    b.record("claude", "default", &report(0.3, 0.40, week), 121_000);
    let v = b.view("claude", 130_000);
    let w = v[0].where_went.clone().unwrap();
    // the weekly window (the longest), this period: a 0.15 (0.10 + 0.05 alone after b ended), b 0.10
    assert_eq!(w.window, "seven_day");
    let got: Vec<(String, i64)> = w.tasks.iter().map(|t| (t.id.clone(), (t.used * 100.0).round() as i64)).collect();
    assert_eq!(got, [("task-a".to_owned(), 20), ("task-b".to_owned(), 10)]);
    assert!((w.traced - 0.30).abs() < 1e-9 && (w.used - 0.40).abs() < 1e-9, "the first 10% was before wisp traced: {w:?}");
    // the host names them and keeps the top ones; the rest are counted
    let t = top(w, 1);
    assert_eq!((t.tasks.len(), t.more), (1, 1));
    // kept across a restart: the store's rows load back
    let rows: Vec<_> = b.take_dirty();
    let back = Budget::load(rows);
    assert_eq!(back.view("claude", 130_000)[0].where_went.as_ref().map(|w| w.tasks.len()), Some(2));
    // a new period starts over; a window past its reset reads fresh, with nothing to say
    b.end("task-a", "a1", 121_000);
    b.begin("claude", "default", "task-c", "c1", 200_000);
    b.record("claude", "default", &report(0.3, 0.05, week + 7 * 24 * H), week + H);
    b.record("claude", "default", &report(0.3, 0.08, week + 7 * 24 * H), week + H + 60_000);
    let w = b.view("claude", week + 2 * H)[0].where_went.clone().unwrap();
    assert_eq!(w.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["task-c"]);
    assert!(b.view("claude", week + 8 * 24 * H)[0].where_went.is_none());
}

fn turn(at: i64, model: &str, input: u64, output: u64, cache: u64) -> TurnSample {
    TurnSample { at, model: model.into(), input, output, cache: Some(cache) }
}

#[test]
fn two_accounts_show_tokens_per_model_per_account() {
    let mut b = Budget::new();
    let now = 10 * 24 * H;
    for i in 0..5 {
        // `input` is everything read, the cache in; `cache` is what of it came from the cache
        b.note_turn("claude", "default", turn(now - i * H, "opus", 10_000, 2_000 + i as u64, 9_000), now);
        b.note_turn("claude", "w1", turn(now - i * H, "opus", 2_000, 4_000, 1_000), now);
        // only one account ran sonnet: nothing to compare
        b.note_turn("claude", "w1", turn(now - i * H, "sonnet", 10, 10, 0), now);
    }
    // under five turns on an account: not shown yet
    for i in 0..4 {
        b.note_turn("claude", "w2", turn(now - i * H, "opus", 1, 99_999, 0), now);
    }
    // older than 7 days and no output don't count
    b.note_turn("claude", "w2", turn(now - 8 * 24 * H, "opus", 1, 99_999, 0), now);
    b.note_turn("claude", "w2", turn(now, "opus", 1, 0, 0), now);
    let c = b.compare_accounts("claude", now);
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!(c[0].model, "opus");
    let a: Vec<(&str, u32, u64, u64)> = c[0].accounts.iter().map(|x| (x.account.as_str(), x.turns, x.output, x.input)).collect();
    // most output first; input counts the cache
    assert_eq!(a, [("w1", 5, 4_000, 2_000), ("default", 5, 2_002, 10_000)]);
    assert!((c[0].accounts[1].cache.unwrap() - 0.9).abs() < 1e-9);
    assert_eq!(b.compare_accounts("codex", now).len(), 0);
}

#[test]
fn plan_windows_give_each_asked_task_its_part_of_every_window_this_period() {
    let mut b = Budget::new();
    let week = 100 * H;
    b.record("claude", "default", &report(0.0, 0.10, week), 1_000);
    b.begin("claude", "default", "job-a", "a1", 1_000);
    b.begin("claude", "default", "mine", "m1", 1_000);
    b.record("claude", "default", &report(0.2, 0.30, week), 61_000);
    let only: std::collections::BTreeSet<String> = ["job-a".to_owned(), "gone".to_owned()].into();
    let w = b.plan_windows(Some(&only), 70_000);
    // both windows moved while the two ran: each shows only job-a's half, and the traced total of both
    let got: Vec<(&str, i64, i64, Vec<&str>)> = w
        .iter()
        .map(|x| {
            (
                x.window.as_str(),
                (x.traced * 100.0).round() as i64,
                (x.tasks["job-a"] * 100.0).round() as i64,
                x.tasks.keys().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(got, [("five_hour", 20, 10, vec!["job-a"]), ("seven_day", 20, 10, vec!["job-a"])]);
    assert_eq!(w[1].since, Some(week - 7 * 24 * H), "the period starts a window's length before its reset");
    assert_eq!(b.plan_windows(None, 70_000)[0].tasks.len(), 2, "None: every task");
    // past its reset the five-hour window is fresh: nothing to say about it
    assert_eq!(b.plan_windows(None, 5 * H + 1).iter().map(|x| x.window.as_str()).collect::<Vec<_>>(), ["seven_day"]);
}
