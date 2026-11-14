//! A banked (early) Codex reset (v1 budget.js resetEarly, F-auto-12): a reading that shows the window reset
//! before the time it last gave is told once per period, so held work can go then; a window that reached its
//! own reset, Codex's drifting "resets in n s" and a reading out of order are not early resets.
#![allow(clippy::unwrap_used)]

use wisp_budget_api::{LimitWindow, LimitsReport};
use wisp_budget_core::Budget;

const H: i64 = 3_600_000;
const NOW: i64 = 1_000 * H;

fn read(used: f64, resets_at: i64) -> LimitsReport {
    LimitsReport {
        windows: vec![LimitWindow { id: "five_hour".into(), used, resets_at: Some(resets_at), ms: Some(5 * H), slot: None }],
        complete: true,
        read: true,
        ..LimitsReport::default()
    }
}

fn full(b: &mut Budget) {
    b.record("codex", "default", &read(1.0, NOW + 2 * H), NOW);
    assert!(b.reset_at("codex", "default", NOW).is_some(), "full: it waits for 2 h from now");
}

#[test]
fn an_early_reset_is_seen_and_frees_the_account_at_once() {
    let mut b = Budget::new();
    full(&mut b);
    let r = b.record("codex", "default", &read(0.02, NOW + 5 * H + 30 * 60_000), NOW + 10 * 60_000);
    assert_eq!(r.early, vec!["five_hour".to_owned()]);
    assert!(b.free("codex", "default", None, NOW + 10 * 60_000), "nothing holds it now, 110 min before the old reset");
    let v = b.view("codex", NOW + 10 * 60_000);
    assert_eq!(v[0].windows[0].early_at, Some(NOW + 10 * 60_000), "the view says Reset early");
}

#[test]
fn a_window_that_reached_its_own_reset_is_no_early_reset() {
    let mut b = Budget::new();
    full(&mut b);
    // the next reading comes after the old reset: a normal new period, nothing to tell
    let r = b.record("codex", "default", &read(0.01, NOW + 7 * H), NOW + 2 * H + 60_000);
    assert!(r.early.is_empty(), "{:?}", r.early);
}

#[test]
fn an_early_reset_is_told_once_even_when_an_old_reading_lands_in_between() {
    let mut b = Budget::new();
    full(&mut b);
    let fresh = NOW + 5 * H;
    assert_eq!(b.record("codex", "default", &read(0.02, fresh), NOW + 60_000).early.len(), 1);
    // a run that started before the reset reports the old period late, then a read says the new one again
    assert_eq!(b.record("codex", "default", &read(0.98, NOW + 2 * H), NOW + 2 * 60_000).early, Vec::<String>::new());
    let again = b.record("codex", "default", &read(0.03, fresh + 60_000), NOW + 3 * 60_000);
    assert!(again.early.is_empty(), "the same period's reset was already told: {:?}", again.early);
    // the same reading twice is nothing either
    assert_eq!(b.record("codex", "default", &read(0.03, fresh + 60_000), NOW + 4 * 60_000).early, Vec::<String>::new());
}

#[test]
fn a_reading_glitch_is_no_reset() {
    // Codex's "resets in n s" drifts a few minutes: the use fell, the reset is the same period
    let mut b = Budget::new();
    full(&mut b);
    assert!(b.record("codex", "default", &read(0.02, NOW + 2 * H + 5 * 60_000), NOW + 60_000).early.is_empty(), "drift");
    // the reset moved later but nearly nothing was given back: not a reset
    let mut b = Budget::new();
    full(&mut b);
    assert!(b.record("codex", "default", &read(0.9, NOW + 5 * H), NOW + 60_000).early.is_empty(), "a moved reset");
    // little was used, little is used: nothing to free
    let mut b = Budget::new();
    b.record("codex", "default", &read(0.06, NOW + 2 * H), NOW);
    assert!(b.record("codex", "default", &read(0.04, NOW + 5 * H), NOW + 60_000).early.is_empty(), "under 10% before");
    // a reading with no reset time says nothing about one
    let mut b = Budget::new();
    full(&mut b);
    let none = LimitsReport {
        windows: vec![LimitWindow { id: "five_hour".into(), used: 0.0, resets_at: None, ms: Some(5 * H), slot: None }],
        ..LimitsReport::default()
    };
    assert!(b.record("codex", "default", &none, NOW + 60_000).early.is_empty(), "no reset time");
}
