//! Where a window's move went (v1 budget.js #sharers, addShare): the turns running on an account between two of its
//! reports share what moved, by how long each ran then; the host keeps each turn's shares on the turn.
#![allow(clippy::unwrap_used)]

use wisp_budget_api::{LimitWindow, LimitsReport, Share};
use wisp_budget_core::Budget;
use wisp_budget_core::where_went::add_share;

fn report(used: f64) -> LimitsReport {
    LimitsReport { windows: vec![LimitWindow { id: "five_hour".into(), used, resets_at: Some(10_000_000), ms: None, slot: None }], ..LimitsReport::default() }
}

#[test]
fn two_turns_on_one_account_share_the_move_by_time_v1_budget_sharers() {
    let mut b = Budget::new();
    assert!(b.record("claude", "default", &report(0.10), 1_000).shares.is_empty(), "the first reading moves nothing");
    b.begin("claude", "default", "a", "a1", 1_000);
    b.begin("claude", "default", "b", "b1", 1_000);
    let r = b.record("claude", "default", &report(0.30), 61_000);
    let mut got: Vec<(String, f64)> = r.shares.iter().map(|(_, t, s)| (t.clone(), (s.used * 1000.0).round() / 1000.0)).collect();
    got.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(got, vec![("a1".into(), 0.1), ("b1".into(), 0.1)], "0.20 moved, split evenly");
    // the shares add up on a turn, never past the whole window
    let mut plan: Vec<Share> = Vec::new();
    for (_, t, s) in &r.shares {
        if t == "a1" {
            add_share(&mut plan, s);
            add_share(&mut plan, s);
        }
    }
    assert_eq!(plan.len(), 1);
    assert!((plan[0].used - 0.2).abs() < 1e-9);
    // an ended turn doesn't share what moves after it
    b.end("b", "b1", 61_000);
    let r = b.record("claude", "default", &report(0.40), 121_000);
    assert!(r.shares.iter().all(|(_, t, _)| t == "a1"), "{:?}", r.shares);
}
