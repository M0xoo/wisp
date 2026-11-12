#![allow(clippy::unwrap_used, clippy::assert_is_empty)]

use serde_json::json;
use wisp_automations_api::{Budget, TriggerEvent, TriggerSpec, When};

use super::*;

fn ev(key: &str) -> TriggerEvent {
    TriggerEvent { on: "pr.opened".into(), key: key.into(), at: 0, payload: json!({ "branch": "main", "project": "/w/api" }), summary: format!("PR {key}"), ..TriggerEvent::default() }
}

fn spec() -> TriggerSpec {
    TriggerSpec { on: "pr.opened".into(), prompt: "review {event.summary}".into(), ..TriggerSpec::default() }
}

fn w(now: i64) -> World {
    World { now, in_window: true, ..World::default() }
}

#[test]
fn same_event_key_fires_once() {
    let (s, mut st) = (spec(), State::default());
    assert!(matches!(admit("t", &s, &mut st, ev("1"), &w(0)), Decision::Start(_)));
    st.running.clear();
    assert_eq!(admit("t", &s, &mut st, ev("1"), &w(10)), Decision::Nothing, "a second poll of the same key");
    // across a restart: the seen set is the saved state
    let mut again: State = serde_json::from_value(serde_json::to_value(&st).unwrap()).unwrap();
    assert_eq!(admit("t", &s, &mut again, ev("1"), &w(20)), Decision::Nothing);
    // bounded
    for i in 0..(SEEN_MAX + 10) {
        again.running.clear();
        admit("t", &s, &mut again, ev(&format!("k{i}")), &w(30));
    }
    assert_eq!(again.seen.len(), SEEN_MAX);
}

#[test]
fn debounce_batches_ten_pushes_into_one_job() {
    let s = TriggerSpec { debounce: "10m".into(), ..spec() };
    let mut st = State::default();
    for i in 0..10 {
        assert!(matches!(admit("t", &s, &mut st, ev(&format!("push{i}")), &w(i * 1000)), Decision::Batched { due: 600_000 }));
    }
    assert_eq!(flush(&s, &mut st, &w(599_999)), None, "not before its window closes");
    let Some(Decision::Start(job)) = flush(&s, &mut st, &w(600_000)) else { panic!("one job") };
    assert_eq!(job.events.len(), 10);
    assert!(fill(&s.prompt, &job).contains("10 events:"));
    assert!(st.batch.is_empty() && flush(&s, &mut st, &w(700_000)).is_none());
}

fn running(st: &mut State) {
    st.running = vec!["s1".into()];
}

#[test]
fn concurrency_skip() {
    let (s, mut st) = (spec(), State::default());
    running(&mut st);
    assert_eq!(admit("t", &s, &mut st, ev("a"), &w(0)), Decision::Skipped("already running".into()));
}

#[test]
fn concurrency_queue() {
    let s = TriggerSpec { concurrency: "queue".into(), ..spec() };
    let mut st = State::default();
    running(&mut st);
    assert!(matches!(admit("t", &s, &mut st, ev("a"), &w(0)), Decision::Queued(_)));
    assert!(drain(&s, &mut st, &w(1)).is_empty(), "still running");
    ended(&s, &mut st, "s1", Outcome::default(), 2);
    let d = drain(&s, &mut st, &w(3));
    assert!(matches!(d.as_slice(), [Decision::Start(j)] if j.events[0].key == "a"));
}

#[test]
fn concurrency_replace() {
    let s = TriggerSpec { concurrency: "replace".into(), ..spec() };
    let mut st = State::default();
    running(&mut st);
    let Decision::Replace { stop, job } = admit("t", &s, &mut st, ev("a"), &w(0)) else { panic!("replace") };
    assert_eq!((stop, job.events[0].key.as_str()), (vec!["s1".to_owned()], "a"));
}

#[test]
fn concurrency_parallel() {
    let s = TriggerSpec { concurrency: "parallel:2".into(), ..spec() };
    let mut st = State::default();
    running(&mut st);
    assert!(matches!(admit("t", &s, &mut st, ev("a"), &w(0)), Decision::Start(_)));
    st.running.push("s2".into());
    assert!(matches!(admit("t", &s, &mut st, ev("b"), &w(1)), Decision::Queued(_)));
}

#[test]
fn rate_limit_holds_with_reason_never_drops() {
    let s = TriggerSpec { rate: "2/h".into(), concurrency: "parallel:9".into(), ..spec() };
    let mut st = State::default();
    assert!(matches!(admit("t", &s, &mut st, ev("1"), &w(0)), Decision::Start(_)));
    assert!(matches!(admit("t", &s, &mut st, ev("2"), &w(1000)), Decision::Start(_)));
    let Decision::Held(why) = admit("t", &s, &mut st, ev("3"), &w(2000)) else { panic!("held") };
    assert!(why.contains("rate 2/h"), "{why}");
    assert_eq!(st.queue.len(), 1, "kept, not dropped");
    assert!(drain(&s, &mut st, &w(10_000)).is_empty(), "the hour isn't up");
    let d = drain(&s, &mut st, &w(3_600_001));
    assert!(matches!(d.as_slice(), [Decision::Start(j)] if j.events[0].key == "3"));
}

#[test]
fn trigger_started_tasks_do_not_retrigger_themselves() {
    let (s, mut st) = (TriggerSpec { on: "task.finished".into(), ..spec() }, State::default());
    let mine = TriggerEvent { on: "task.finished".into(), by: Some("trigger:review".into()), ..ev("x") };
    assert!(matches!(admit("review", &s, &mut st, mine, &w(0)), Decision::Skipped(w) if w.contains("own task")));
    // another trigger's task is fine, until the chain is 3 deep
    let other = TriggerEvent { on: "task.finished".into(), by: Some("trigger:lint".into()), depth: 2, ..ev("y") };
    assert!(matches!(admit("review", &s, &mut st, other, &w(1)), Decision::Start(_)));
    st.running.clear();
    let deep = TriggerEvent { on: "task.finished".into(), by: Some("trigger:lint".into()), depth: 3, ..ev("z") };
    assert!(matches!(admit("review", &s, &mut st, deep, &w(2)), Decision::Skipped(w) if w.contains("loop")));
}

#[test]
fn a_pipeline_step_of_a_task_does_not_fire_its_trigger_again() {
    let (s, mut st) = (TriggerSpec { on: "task.finished".into(), ..spec() }, State::default());
    let task = TriggerEvent { on: "task.finished".into(), ..ev("task-1:turn-1") };
    assert!(matches!(admit("after", &s, &mut st, task, &w(0)), Decision::Start(_)));
    // the trigger's own run ended before the review did: no "already running" to hide a second fire
    st.running.clear();
    let review = TriggerEvent { on: "task.finished".into(), by: Some("pipeline:default".into()), ..ev("review-1:turn-1") };
    assert!(matches!(admit("after", &s, &mut st, review, &w(1)), Decision::Skipped(w) if w.contains("pipeline step")));
    assert_eq!(st.runs_total, 1, "one task, one fire");
}

#[test]
fn mention_in_chat_from_unknown_user_is_refused() {
    let chat = |user: &str| TriggerEvent { on: "chat.message".into(), key: format!("m-{user}"), payload: json!({ "user": user, "text": "@ada deploy please", "channel": "C1" }), ..TriggerEvent::default() };
    let s = TriggerSpec { on: "chat.message".into(), crew: "ada".into(), users: vec!["bo".into()], ..TriggerSpec::default() };
    let mut st = State::default();
    assert!(matches!(admit("t", &s, &mut st, chat("eve"), &w(0)), Decision::Skipped(w) if w.contains("users")));
    assert!(matches!(admit("t", &s, &mut st, chat("bo"), &w(1)), Decision::Start(_)));
    // no users at all: refused (an open channel says users: anyone)
    let open = TriggerSpec { users: Vec::new(), ..s.clone() };
    assert!(matches!(admit("t", &open, &mut State::default(), chat("eve"), &w(2)), Decision::Skipped(_)));
    let anyone = TriggerSpec { users: vec!["anyone".into()], ..s };
    assert!(matches!(admit("t", &anyone, &mut State::default(), chat("eve"), &w(3)), Decision::Start(_)));
}

#[test]
fn paused_member_queues_wakes_and_resume_drains_in_order() {
    let s = TriggerSpec { crew: "ada".into(), concurrency: "parallel:9".into(), ..spec() };
    let mut st = State::default();
    let paused = World { member_paused: true, ..w(0) };
    for k in ["1", "2", "3"] {
        assert!(matches!(admit("t", &s, &mut st, ev(k), &paused), Decision::Held(_)));
    }
    assert!(drain(&s, &mut st, &paused).is_empty(), "still paused");
    let d = drain(&s, &mut st, &w(10));
    let keys: Vec<String> = d.iter().filter_map(|x| if let Decision::Start(j) = x { Some(j.events[0].key.clone()) } else { None }).collect();
    assert_eq!(keys, ["1", "2", "3"]);
}

#[test]
fn member_quiet_answer_is_skipped_not_failed() {
    let (s, mut st) = (spec(), State::default());
    st.running = vec!["s1".into()];
    st.failures = 2;
    assert_eq!(ended(&s, &mut st, "s1", Outcome { quiet: true, ..Outcome::default() }, 5), None);
    assert_eq!((st.failures, st.deliveries.back().unwrap().result.as_str()), (2, "skipped by member"));
}

#[test]
fn three_failures_pause_and_notify() {
    let s = TriggerSpec { cooldown: "1m".into(), ..spec() };
    let mut st = State::default();
    let failed = Outcome { failed: true, ..Outcome::default() };
    for i in 0..2 {
        st.running = vec![format!("s{i}")];
        assert_eq!(ended(&s, &mut st, &format!("s{i}"), failed, i), None);
    }
    // a cooldown holds the next one
    assert!(matches!(admit("t", &s, &mut st, ev("a"), &w(10)), Decision::Held(w) if w.contains("cooling")));
    st.running = vec!["s9".into()];
    let why = ended(&s, &mut st, "s9", failed, 100).unwrap();
    assert!(why.contains("3 failed runs"));
    assert!(matches!(admit("t", &s, &mut st, ev("b"), &w(200_000)), Decision::Skipped(w) if w.starts_with("paused")));
}

#[test]
fn poll_backoff_on_gh_rate_limit() {
    let every = 300_000;
    assert_eq!(next_poll(every, 0, 0, PollOutcome::Ok), (300_000, 0));
    // a rate limit waits for its reset, and isn't a failure
    assert_eq!(next_poll(every, 0, 2, PollOutcome::RateLimited { reset_at: 1_800_000 }), (1_800_000, 2));
    // an error backs off, doubling, at most an hour
    assert_eq!(next_poll(every, 0, 0, PollOutcome::Failed), (600_000, 1));
    assert_eq!(next_poll(every, 0, 5, PollOutcome::Failed).0, 3_600_000);
}

#[test]
fn approval_never_added_in_full_auto() {
    let s = TriggerSpec { approval: true, ..spec() };
    assert!(matches!(admit("t", &s, &mut State::default(), ev("a"), &w(0)), Decision::Awaiting(_)));
    let auto = World { full_auto: true, ..w(0) };
    assert!(matches!(admit("t", &s, &mut State::default(), ev("a"), &auto), Decision::Start(_)), "Full auto never asks");
}

#[test]
fn budget_guard_holds_triggered_run_over_daily_cap() {
    let s = TriggerSpec { budget: Some(Budget { per_day: Some(1.0), per_run: None }), concurrency: "parallel:9".into(), ..spec() };
    let mut st = State::default();
    let Decision::Start(_) = admit("t", &s, &mut st, ev("1"), &w(0)) else { panic!() };
    st.running = vec!["s1".into()];
    ended(&s, &mut st, "s1", Outcome { cost: 1.2, ..Outcome::default() }, 10);
    let Decision::Held(why) = admit("t", &s, &mut st, ev("2"), &w(20)) else { panic!("held") };
    assert!(why.contains("budget"), "{why}");
    // the next day it goes
    let d = drain(&s, &mut st, &w(86_400_000 + 5));
    assert!(matches!(d.as_slice(), [Decision::Start(_)]));
}

#[test]
fn filters_if_and_windows() {
    let s = TriggerSpec { project: "/w/api".into(), cond: "event.payload.branch == 'main'".into(), ..spec() };
    let mut st = State::default();
    assert!(matches!(admit("t", &s, &mut st, ev("1"), &w(0)), Decision::Start(_)));
    let other = TriggerEvent { payload: json!({ "branch": "dev", "project": "/w/api" }), ..ev("2") };
    st.running.clear();
    assert_eq!(admit("t", &s, &mut st, other, &w(1)), Decision::Nothing);
    let elsewhere = TriggerEvent { payload: json!({ "branch": "main", "project": "/w/web" }), ..ev("3") };
    assert_eq!(admit("t", &s, &mut st, elsewhere, &w(2)), Decision::Nothing);
    let night = TriggerSpec { when: Some(When { hours: "9-17".into(), outside: "queue".into(), ..When::default() }), ..spec() };
    assert!(matches!(admit("t", &night, &mut State::default(), ev("4"), &World { in_window: false, ..w(0) }), Decision::Queued(_)));
    assert!(glob("pr.*", "pr.opened") && glob("*ed", "pr.opened") && !glob("pr.*", "issue.opened") && glob("a*b*c", "axxbyyc"));
}

#[test]
fn a_project_on_a_webhook_or_schedule_trigger_is_where_it_runs_not_a_filter() {
    for on in ["webhook", "schedule", "once", "manual"] {
        let s = TriggerSpec { on: on.into(), project: "/w/api".into(), ..spec() };
        let e = TriggerEvent { on: on.into(), key: format!("{on}:1"), payload: json!({ "ref": "refs/heads/main" }), ..TriggerEvent::default() };
        assert!(matches!(admit("t", &s, &mut State::default(), e, &w(0)), Decision::Start(_)), "{on}");
    }
    // an explicit match on project still filters, and an event source's flat project too
    let s = TriggerSpec { on: "webhook".into(), filters: [("project".to_owned(), json!("/w/api"))].into_iter().collect(), ..spec() };
    let e = TriggerEvent { on: "webhook".into(), key: "w:2".into(), payload: json!({}), ..TriggerEvent::default() };
    assert_eq!(admit("t", &s, &mut State::default(), e, &w(0)), Decision::Nothing);
}

#[test]
fn crew_wake_cycles_are_found() {
    let reported = |member: &str| TriggerSpec { on: "crew.reported".into(), filters: [("member".to_owned(), json!(member))].into_iter().collect(), ..TriggerSpec::default() };
    let wakes = vec![("bo".to_owned(), reported("ada")), ("cy".to_owned(), reported("bo"))];
    assert_eq!(wake_cycle(&wake_edges(&wakes)), None);
    let mut looped = wakes;
    looped.push(("ada".to_owned(), reported("cy")));
    assert_eq!(wake_cycle(&wake_edges(&looped)), Some(vec!["ada".to_owned(), "bo".to_owned(), "cy".to_owned(), "ada".to_owned()]));
}

#[test]
fn test_dry_run_starts_nothing() {
    let s = TriggerSpec { rate: "2/h".into(), concurrency: "parallel:5".into(), ..spec() };
    let st = State::default();
    let tried = dry_run("t", &s, &st, vec![ev("1"), ev("2"), ev("3")], &w(0));
    let words: Vec<&str> = tried.iter().map(|t| word(&t.decision).0).collect();
    assert_eq!(words, ["started", "started", "held"], "the rate shows as it would");
    assert_eq!(tried[0].prompt, "review PR 1", "the template filled from the event");
    assert_eq!(st, State::default(), "the real state is untouched: no seen keys, no runs, no queue");
    // and the real trigger still fires on those keys afterwards
    let mut real = st;
    assert!(matches!(admit("t", &s, &mut real, ev("1"), &w(1)), Decision::Start(_)));
}

#[test]
fn source_plugin_off_marks_triggers_unavailable() {
    let owners = vec![("wisp.github".to_owned(), false)];
    let why = availability("ci.failed", &owners).unwrap();
    assert!(why.contains("wisp.github") && why.contains("off"), "{why}");
    assert_eq!(availability("ci.failed", &[("wisp.github".to_owned(), true)]), None);
    assert_eq!(availability("nobody.offers", &[]).as_deref(), Some("no plugin offers nobody.offers"));
    // an unavailable trigger stays listed (its state keeps it) and skips with why, without a failure
    let mut st = State { unavailable: Some(why.clone()), ..State::default() };
    assert_eq!(admit("t", &spec(), &mut st, ev("1"), &w(0)), Decision::Skipped(why));
    assert_eq!((st.failures, st.paused.is_none()), (0, true));
    // switched back on: it runs
    st.unavailable = availability("ci.failed", &[("wisp.github".to_owned(), true)]);
    assert!(matches!(admit("t", &spec(), &mut st, ev("2"), &w(1)), Decision::Start(_)));
}

#[test]
fn when_windows_read_days_and_hours() {
    let h = 3_600_000;
    let mon = 4 * 86_400_000; // 1970-01-05 was a Monday
    let office = When { days: vec!["mon-fri".into()], hours: "09:00-18:00".into(), ..When::default() };
    assert!(in_window(&office, mon + 10 * h));
    assert!(!in_window(&office, mon + 19 * h));
    assert!(!in_window(&office, mon - 14 * h), "Sunday 10:00");
    let night = When { days: vec!["fri".into()], hours: "22:00-06:00".into(), ..When::default() };
    let fri = mon + 4 * 86_400_000;
    assert!(in_window(&night, fri + 23 * h));
    assert!(in_window(&night, fri + 24 * h + 2 * h), "Saturday 02:00 belongs to Friday night");
    assert!(!in_window(&night, fri + 2 * h), "Friday 02:00 is Thursday's night");
}
