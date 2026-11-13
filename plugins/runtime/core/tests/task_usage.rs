//! v1 #785 (TRY-16): a task's usage includes its subagents', and how full its context is, from the harness's own
//! numbers only (v1 test/task-usage.test.js, ported).
#![allow(clippy::unwrap_used, clippy::float_cmp)]

use std::collections::BTreeMap;

use serde_json::json;
use wisp_runtime_api::model::{Turn, TurnStats, TurnStatus};
use wisp_runtime_core::task_usage::{Context, Own, SubUsage, context_of, own_of, sub_usage, turn_usage, with_subs};

fn turn(idx: u32, st: TurnStats) -> Turn {
    Turn { idx, agent: "claude".into(), status: TurnStatus::Done, stats: Some(st), ..Turn::default() }
}
fn ctx(tokens: u64, window: Option<u64>, output: u64) -> TurnStats {
    TurnStats { context_tokens: Some(tokens), context_window: window, output_tokens: Some(output), ..TurnStats::default() }
}
fn with_plan(mut t: Turn, agent: &str, window: &str, used: f64) -> Turn {
    t.ext.insert("wisp.budget".into(), json!({ "plan": [{ "agent": agent, "account": "default", "window": window, "used": used }] }));
    t
}
fn usages(ts: &[Turn]) -> Vec<wisp_runtime_core::task_usage::TurnUsage> {
    ts.iter().map(turn_usage).collect()
}

#[test]
fn the_context_is_the_newest_measured_turns_with_the_window_of_the_turn_that_said_it_v1_785() {
    let base = vec![turn(0, ctx(80_000, Some(200_000), 10)), turn(1, ctx(124_000, None, 5))];
    // a turn without the window takes the one before
    assert_eq!(context_of(&usages(&base)), Some(Context { tokens: 124_000, window: 200_000 }));
    // a compaction says 0: the context is small again, not unknown
    let compacted = [base.clone(), vec![turn(2, ctx(0, None, 0))]].concat();
    assert_eq!(context_of(&usages(&compacted)), Some(Context { tokens: 0, window: 200_000 }));
    // a later turn that worked without a number (another harness): no guess
    let other =
        [base.clone(), vec![turn(2, TurnStats { input_tokens: Some(900), output_tokens: Some(40), ..TurnStats::default() })]].concat();
    assert_eq!(context_of(&usages(&other)), None);
    // one still running doesn't count yet; one that did no work changes nothing
    let running = Turn { idx: 3, status: TurnStatus::Running, ..Turn::default() };
    let idle = [base.clone(), vec![turn(2, TurnStats::default()), running]].concat();
    assert_eq!(context_of(&usages(&idle)), Some(Context { tokens: 124_000, window: 200_000 }));
    assert_eq!(context_of(&[]), None);
    // a turn whose main thread wrote nothing (only its CLI subagents did, in its per-model counts) moved nothing on
    let models = BTreeMap::from([("claude-haiku-5-5".to_owned(), json!({ "input": 900, "output": 300 }))]);
    let agents_only = [base, vec![turn(2, TurnStats { output_tokens: Some(0), models: Some(models), ..TurnStats::default() })]].concat();
    assert_eq!(context_of(&usages(&agents_only)), Some(Context { tokens: 124_000, window: 200_000 }));
}

#[test]
fn a_tasks_tokens_count_cache_and_its_cli_subagents_through_its_models_v1_785() {
    let plain = turn(0, TurnStats { input_tokens: Some(1000), cache_tokens: Some(9000), output_tokens: Some(500), ..TurnStats::default() });
    // the per-model counts hold an Explore agent's tokens the main thread's usage left out
    let models = BTreeMap::from([
        ("claude-opus-5-5".to_owned(), json!({ "input": 500, "cacheRead": 4500, "cacheWrite": 0, "output": 200 })),
        ("claude-haiku-5-5".to_owned(), json!({ "input": 2000, "cacheRead": 0, "cacheWrite": 0, "output": 300 })),
    ]);
    let sub = turn(
        1,
        TurnStats {
            input_tokens: Some(500),
            cache_tokens: Some(4500),
            output_tokens: Some(200),
            models: Some(models),
            ..TurnStats::default()
        },
    );
    let running = Turn { idx: 2, status: TurnStatus::Running, ..Turn::default() };
    let own = own_of(&usages(&[plain, sub, running]));
    assert_eq!(own.tokens, 10_500 + 7_500);
    assert_eq!(own_of(&[]), Own::default(), "nothing run: nothing to say");
}

#[test]
fn a_leads_usage_adds_its_subagents_and_only_the_same_plans_share_v1_785() {
    let lead = own_of(&usages(&[with_plan(
        turn(0, TurnStats { input_tokens: Some(100), cache_tokens: Some(900), output_tokens: Some(50), ..TurnStats::default() }),
        "claude",
        "seven_day",
        0.04,
    )]));
    assert_eq!(lead.tokens, 1050);
    let tester = own_of(&usages(&[with_plan(
        turn(0, TurnStats { input_tokens: Some(10), output_tokens: Some(5), ..TurnStats::default() }),
        "claude",
        "seven_day",
        0.02,
    )]));
    let reviewer = own_of(&usages(&[with_plan(
        turn(0, TurnStats { input_tokens: Some(20), output_tokens: Some(5), ..TurnStats::default() }),
        "codex",
        "seven_day",
        0.1,
    )]));
    let subs: Vec<SubUsage> = [
        ("k", "tester", "Tests", "claude", &tester),
        ("c", "reviewer", "Tests", "codex", &reviewer),
        ("z", "", "Idle", "claude", &Own::default()),
    ]
    .into_iter()
    .filter_map(|(id, name, title, agent, own)| sub_usage(&lead, "claude default", (id, name, title, agent), own))
    .collect();
    assert_eq!(subs.len(), 2, "one that took nothing measured isn't listed");
    assert_eq!((subs[0].name.as_str(), subs[0].tokens, subs[0].same_plan), ("tester", 15, true));
    // one on another harness is on another plan
    assert_eq!((subs[1].name.as_str(), subs[1].same_plan), ("reviewer", false));
    let total = with_subs(&lead, &subs);
    assert_eq!(total.tokens, 1050 + 15 + 25, "every token, the subagents' in");
    // the line adds only the share of the same plan: Codex's weekly isn't Claude's
    assert_eq!(total.plan.get("seven_day"), Some(&0.06));
    // the wire: samePlan said only when false
    assert_eq!(serde_json::to_value(&subs[0]).unwrap().get("samePlan"), None);
    assert_eq!(serde_json::to_value(&subs[1]).unwrap()["samePlan"], json!(false));
}

#[test]
fn before_the_lead_has_a_share_its_plan_is_the_one_it_runs_on_v1_785() {
    let lead = own_of(&usages(&[turn(0, TurnStats { output_tokens: Some(5), ..TurnStats::default() })]));
    let sub =
        own_of(&usages(&[with_plan(turn(0, TurnStats { output_tokens: Some(5), ..TurnStats::default() }), "claude", "five_hour", 0.03)]));
    let on_claude = sub_usage(&lead, "claude default", ("k", "tester", "", "claude"), &sub).unwrap();
    assert!(on_claude.same_plan);
    let on_codex = sub_usage(&lead, "codex default", ("k", "tester", "", "claude"), &sub).unwrap();
    assert!(!on_codex.same_plan);
    assert_eq!(with_subs(&lead, &[on_claude]).plan.get("five_hour"), Some(&0.03));
}

#[test]
fn a_turn_keeps_its_cli_subagents_and_the_fold_sums_them_by_type_v1_785() {
    use wisp_runtime_api::model::SubagentStat;
    use wisp_runtime_core::task_usage::Agents;
    // what the Claude parser puts on a result (plugins/claude/core tests/subagent_types.rs) lands on the turn
    let mut hs = wisp_runtime_api::harness::HarnessStats::default();
    hs.extra.insert(
        "subagents".into(),
        json!([{ "type": "web-fetch", "calls": 2, "read": 2100, "output": 27000, "model": "claude-opus-5-5", "same": true }, { "type": "", "calls": 1 }, { "type": "Plan", "calls": 0 }]),
    );
    let st = wisp_runtime_core::land::turn_stats(&hs);
    assert_eq!(
        st.subagents,
        vec![SubagentStat { kind: "web-fetch".into(), calls: 2, read: 2100, output: 27000, model: "claude-opus-5-5".into() }],
        "a row with no type or no call is dropped"
    );
    assert_eq!(wisp_runtime_core::land::turn_stats(&wisp_runtime_api::harness::HarnessStats::default()).subagents, vec![]);
    // a v1 turn from before stats.totals: its output could be the conversation's, so it reads as unknown
    let before = wisp_runtime_core::land::subagents_of(Some(&json!([{ "type": "Explore", "calls": 1, "output": 300, "read": 40 }])), false);
    assert_eq!(before[0].output, 0);
    assert_eq!(before[0].read, 40);

    let sa = |kind: &str, calls, output, model: &str| SubagentStat { kind: kind.into(), calls, read: 1, output, model: model.into() };
    let t0 = turn(
        0,
        TurnStats {
            output_tokens: Some(500),
            subagents: vec![sa("Explore", 2, 300, "claude-haiku-5-5"), sa("Plan", 1, 50, "claude-opus-5-5")],
            ..TurnStats::default()
        },
    );
    let t1 = turn(
        1,
        TurnStats {
            output_tokens: Some(200),
            subagents: vec![sa("Explore", 1, 100, "claude-haiku-5-5"), sa("Explore", 1, 900, "claude-opus-5-5")],
            ..TurnStats::default()
        },
    );
    let running = Turn { idx: 2, status: TurnStatus::Running, ..Turn::default() };
    let own = own_of(&usages(&[t0, t1, running]));
    let a = |kind: &str, model: &str, calls, output| Agents { kind: kind.into(), model: model.into(), calls, output };
    // by type and model, most output first
    assert_eq!(
        own.agents,
        vec![a("Explore", "claude-opus-5-5", 1, 900), a("Explore", "claude-haiku-5-5", 3, 400), a("Plan", "claude-opus-5-5", 1, 50)]
    );
    // on the row: `agents`, absent when none ran
    let v = serde_json::to_value(&own).unwrap();
    assert_eq!(v["agents"][1], json!({ "type": "Explore", "model": "claude-haiku-5-5", "calls": 3, "output": 400 }));
    assert!(serde_json::to_value(own_of(&[])).unwrap().get("agents").is_none());
}
