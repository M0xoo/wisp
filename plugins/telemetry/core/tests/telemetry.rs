//! The PostHog client's rules (v1 server/telemetry.js; ports the TypeScript reference's
//! telemetry.test.ts and the unit half of v1 test/feedback.test.js).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use common::{HOME, NOW, golden, id, props, telemetry};
use serde_json::{Value, json};
use wisp_telemetry_core::env::{MAX_QUEUE, batch_body, batch_url, env_disabled, feedback_available, host_of, setting_on, shell_of};
use wisp_telemetry_core::{ErrorInfo, Props, Tracked};

#[test]
fn opt_outs_no_key_do_not_track_wisp_telemetry_ci_or_the_switch() {
    let e = common::env;
    assert!(!env_disabled(&e(&[])));
    for off in [&[("WISP_POSTHOG_KEY", "")][..], &[("DO_NOT_TRACK", "1")], &[("WISP_TELEMETRY", "0")], &[("WISP_TELEMETRY", "off")], &[("WISP_TELEMETRY", "No")], &[("CI", "true")], &[("CI", "1")]] {
        assert!(env_disabled(&e(off)), "{off:?}");
    }
    for on in [&[("DO_NOT_TRACK", "0")][..], &[("DO_NOT_TRACK", "")], &[("CI", "false")], &[("CI", "")], &[("WISP_TELEMETRY", "1")], &[("WISP_TELEMETRY", "")]] {
        assert!(!env_disabled(&e(on)), "{on:?}");
    }
    let mut t = telemetry(&[]);
    assert!(t.enabled(), "unset is on");
    t.setting_on = setting_on(Some(&json!("off")));
    assert!(!t.enabled());
    assert!(setting_on(None) && setting_on(Some(&json!("on"))) && setting_on(Some(&json!(null))));
}

#[test]
fn the_matrix_of_who_may_send_is_pinned() {
    let cases = [("none", vec![]), ("no key", vec![("WISP_POSTHOG_KEY", "")]), ("DO_NOT_TRACK=1", vec![("DO_NOT_TRACK", "1")]), ("WISP_TELEMETRY=0", vec![("WISP_TELEMETRY", "0")]), ("CI=true", vec![("CI", "true")]), ("WISP_FEEDBACK=0", vec![("WISP_FEEDBACK", "0")])];
    let rows: Vec<Value> = cases.iter().map(|(n, pairs)| {
        let env = common::env(pairs);
        json!({ "env": n, "stats": !env_disabled(&env), "feedback": feedback_available(&env) })
    }).collect();
    golden("opt-outs", &json!(rows));
}

#[test]
fn counting_through_the_off_switch_and_what_leaves() {
    let mut off = telemetry(&[]);
    off.setting_on = false;
    assert_eq!(off.track("try_two_ways", Props::new(), NOW, id), Tracked::Off);
    assert!(off.queue.is_empty());
    let mut env_off = telemetry(&[("WISP_TELEMETRY", "0")]);
    env_off.track("try_two_ways", Props::new(), NOW, id);
    assert!(env_off.queue.is_empty() && env_off.install_id.is_none(), "off: no id made either");
    let mut on = telemetry(&[]);
    on.track("try_two_ways", Props::new(), NOW, id);
    let mut keys: Vec<&String> = props(&on.queue[0]).keys().collect();
    keys.sort();
    assert_eq!(keys, ["$lib", "$process_person_profile", "arch", "distinct_id", "os", "osRelease", "shell", "version"]);
    assert_eq!(on.queue[0]["event"], "try_two_ways");
    assert_eq!(on.queue[0]["timestamp"], "2026-11-07T00:00:00.000Z");
}

#[test]
fn one_random_id_per_install_made_on_the_first_event() {
    let mut t = telemetry(&[]);
    let mut made = 0;
    t.track("a", Props::new(), NOW, || {
        made += 1;
        id()
    });
    t.track("b", Props::new(), NOW, || "other".into());
    assert_eq!(made, 1);
    assert!(t.queue.iter().all(|e| e["properties"]["distinct_id"] == id().as_str()));
}

#[test]
fn the_queue_asks_for_a_flush_at_fifty_and_drains() {
    let mut t = telemetry(&[]);
    for _ in 1..MAX_QUEUE {
        assert_eq!(t.track("x", Props::new(), NOW, id), Tracked::Queued);
    }
    assert_eq!(t.track("x", Props::new(), NOW, id), Tracked::Flush);
    assert_eq!(t.drain().len(), MAX_QUEUE);
    assert!(t.queue.is_empty(), "a failed flush drops them: telemetry never gets in the way");
}

#[test]
fn capture_error_in_posthog_format_scrubbed() {
    let mut t = telemetry(&[]);
    let err = ErrorInfo { name: Some("TypeError".into()), message: format!("cannot read {HOME}/code/secret-project/a.ts"), stack: Some(format!("TypeError: x\n    at run (/opt/wisp/src/a.ts:3:4)\n    at other ({HOME}/code/app/node_modules/x/y.js:1:2)")) };
    let mut p = Props::new();
    p.insert("route".into(), json!("GET /sessions/:id"));
    t.capture_error(&err, p, NOW, id);
    let e = &t.queue[0];
    assert_eq!(e["event"], "$exception");
    assert_eq!(e["properties"]["route"], "GET /sessions/:id");
    let ex = &e["properties"]["$exception_list"][0];
    assert_eq!(ex["type"], "TypeError");
    assert_eq!(ex["value"], "cannot read …/a.ts", "a path outside wisp keeps only its file name");
    assert!(!e.to_string().contains(HOME));
    assert_eq!(ex["mechanism"], json!({ "handled": true, "synthetic": false }));
    let frames = ex["stacktrace"]["frames"].as_array().unwrap();
    assert_eq!(frames.last().unwrap()["function"], "run", "innermost last");
    assert_eq!(frames.last().unwrap()["filename"], "<wisp>/src/a.ts");
    assert_eq!(frames.last().unwrap()["in_app"], true);
    assert_eq!(frames[0]["in_app"], false);
    golden("exception", e);
}

#[test]
fn a_crash_is_captured_unhandled_and_kept_for_the_next_start() {
    let mut t = telemetry(&[]);
    let kept = t.crashed(&ErrorInfo { name: Some("RangeError".into()), message: "boom".into(), stack: None }, NOW, id);
    assert!(t.queue.is_empty());
    let mut next = telemetry(&[]);
    next.restore(kept);
    let ex = &next.queue[0]["properties"]["$exception_list"][0];
    assert_eq!(ex["type"], "RangeError");
    assert_eq!(ex["mechanism"]["handled"], false);
    let mut plain = telemetry(&[]);
    let kept = plain.crashed(&ErrorInfo { message: "panic".into(), ..ErrorInfo::default() }, NOW, id);
    assert_eq!(kept[0]["properties"]["$exception_list"][0]["type"], "UncaughtException");
}

#[test]
fn what_was_queued_at_shutdown_goes_next_start_unless_stats_are_off_by_then() {
    let mut t = telemetry(&[]);
    for _ in 0..250 {
        t.track("a", Props::new(), NOW, id);
    }
    let pending = t.persist();
    assert_eq!(pending.len(), 200, "the last 200");
    let mut off = telemetry(&[("DO_NOT_TRACK", "1")]);
    off.restore(pending);
    assert!(off.queue.is_empty());
}

#[test]
fn feedback_goes_out_with_stats_off_under_a_one_off_id_home_scrubbed() {
    let mut t = telemetry(&[]);
    t.setting_on = false;
    t.install_id = Some("install".into());
    let mut p = Props::new();
    p.insert("text".into(), json!(format!("broke in {HOME}/code/app")));
    p.insert("rating".into(), json!("down"));
    let batch = t.feedback("feedback", p, &[], NOW, "one-off".into()).unwrap();
    let e = &batch[0];
    assert_eq!(e["event"], "feedback");
    assert_eq!(e["properties"]["text"], "broke in ~/code/app");
    assert_eq!(e["properties"]["rating"], "down");
    assert_eq!(e["properties"]["version"], "2.0.0");
    assert_eq!(e["properties"]["distinct_id"], "one-off", "not tied to the analytics id");
    t.setting_on = true;
    assert_eq!(t.feedback("feedback", Props::new(), &[], NOW, "x".into()).unwrap()[0]["properties"]["distinct_id"], "install");
    golden("feedback", e);
}

#[test]
fn wisp_feedback_0_or_no_key_sends_nothing() {
    assert!(telemetry(&[("WISP_FEEDBACK", "0")]).feedback("feedback", Props::new(), &[], NOW, id()).is_none());
    assert!(telemetry(&[("WISP_POSTHOG_KEY", "")]).feedback("feedback", Props::new(), &[], NOW, id()).is_none());
    assert!(telemetry(&[("WISP_TELEMETRY", "0"), ("DO_NOT_TRACK", "1")]).feedback("feedback", Props::new(), &[], NOW, id()).is_some());
}

#[test]
fn offline_feedback_goes_with_the_next_one_the_last_hundred_and_long_text_is_cut() {
    let t = telemetry(&[]);
    let outbox: Vec<Value> = (0..120).map(|i| json!({ "event": "feedback", "n": i })).collect();
    let mut p = Props::new();
    p.insert("text".into(), json!("é".repeat(5000)));
    let batch = t.feedback("feedback", p, &outbox, NOW, id()).unwrap();
    assert_eq!(batch.len(), 100);
    assert_eq!(batch[0]["n"], 21);
    assert_eq!(batch[99]["properties"]["text"].as_str().unwrap().chars().count(), 4000);
}

#[test]
fn shells_hosts_and_the_batch_request() {
    let e = common::env;
    assert_eq!(shell_of(&e(&[("WISP_DESKTOP", "tauri")])), "tauri");
    assert_eq!(shell_of(&e(&[("WISP_GRID_URL", "https://grid.example")])), "grid");
    assert_eq!(shell_of(&e(&[])), "browser");
    assert_eq!(host_of(&e(&[("WISP_POSTHOG_HOST", "https://eu.i.posthog.com/")])), "https://eu.i.posthog.com");
    assert_eq!(batch_url(&e(&[])), "https://us.i.posthog.com/batch/");
    let body: Value = serde_json::from_slice(&batch_body(&e(&[]), &[json!({ "event": "x" })])).unwrap();
    assert_eq!(body["api_key"], wisp_telemetry_core::env::DEFAULT_KEY);
    assert_eq!(body["batch"][0]["event"], "x");
}
