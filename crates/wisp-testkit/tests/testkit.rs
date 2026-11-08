//! The testkit itself: the fake clock drives kernel time, the free tests pass on a well-behaved plugin
//! and catch a command reachable without its permission, goldens compare and rewrite, and the fake
//! harness and gh behave like v1's.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value
)]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{
    Caller, Clock, Code, Command, Failure, Hook, InterceptOpts, Manifest, Plugin, Result, Setup,
    Verdict,
};
use wisp_testkit::{
    FakeClock, TestApp, assert_deactivate_leaks_nothing, assert_golden_at,
    assert_missing_permission_refused, install_fakes,
};

struct Go;
impl Command for Go {
    const ID: &'static str = "sample.go";
    type Args = Value;
    type Out = Value;
}
struct Open;
impl Command for Open {
    const ID: &'static str = "sample.open";
    // a command that names a permission every set holds would be reachable by anyone
    const PERMISSION: Option<&'static str> = Some("sample:open");
    type Args = ();
    type Out = ();
}
struct Before;
impl Hook for Before {
    const ID: &'static str = "before:go";
    type Ctx = Value;
}

/// A plugin that uses most of the kernel: a command, an interceptor, a subscriber, a task, a watcher.
struct Sample {
    slow_ms: u64,
}
impl Plugin for Sample {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.sample", "version": "1.0.0", "api": "^1", "requires": { "wisp.runtime": "^1" } })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Go, _, _>(|ctx, call, v| async move { ctx.run_hook::<Before>(&call, v).await });
        s.command::<Open, _, _>(|_, _, ()| async { Ok(()) });
        let slow = self.slow_ms;
        s.intercept::<Before, _, _>(
            InterceptOpts {
                failure: Failure::Closed,
                timeout_ms: 100,
                ..Default::default()
            },
            move |ctx, _, c| async move {
                if slow > 0
                    && let Ok(clock) = ctx.clock()
                {
                    clock.sleep(slow).await;
                }
                Verdict::Modify {
                    ctx: json!({ "seen": c }),
                }
            },
        );
        let ctx = s.ctx();
        ctx.watch_setting("sample.x", |_| {});
        s.on_start(move |ctx| async move {
            ctx.spawn(std::future::pending());
            Ok(())
        });
        Ok(())
    }
}

#[tokio::test]
async fn the_fake_clock_moves_only_when_told() {
    let c = FakeClock::at(1000);
    let sleep = c.sleep(50);
    assert_eq!(c.sleepers(), 1);
    c.advance(49);
    assert_eq!(c.sleepers(), 1);
    c.advance(1);
    sleep.await;
    assert_eq!(c.now_ms(), 1050);
}

#[tokio::test]
async fn interceptor_budgets_run_on_the_fake_clock() {
    let clock = FakeClock::default();
    let k = TestApp::new()
        .clock(&clock)
        .with(Sample { slow_ms: 500 })
        .start()
        .await;
    let call = tokio::spawn({
        let k = k.clone();
        async move { k.call(Caller::user(), "sample.go", json!(1)).await }
    });
    while clock.sleepers() < 2 {
        tokio::task::yield_now().await;
    }
    clock.advance(100); // the 100 ms budget ends before the interceptor's 500 ms
    let e = call.await.unwrap().unwrap_err();
    assert_eq!(e.code, Code::Vetoed);
    assert!(e.message.contains("within 100 ms"), "{}", e.message);
}

#[tokio::test]
async fn test_app_stubs_what_a_plugin_requires() {
    let k = TestApp::new().with(Sample { slow_ms: 0 }).start().await;
    assert_eq!(
        k.call(Caller::user(), "sample.go", json!(1)).await.unwrap(),
        json!({ "seen": 1 })
    );
    assert!(
        k.status()
            .iter()
            .any(|s| s.id == "wisp.runtime" && s.state == "active")
    );
}

#[tokio::test]
async fn the_free_tests_pass_on_a_well_behaved_plugin() {
    assert_deactivate_leaks_nothing(Sample { slow_ms: 0 }).await;
    assert_missing_permission_refused(Sample { slow_ms: 0 }, "sample.go", json!(1)).await;
    assert_missing_permission_refused(Sample { slow_ms: 0 }, "sample.open", Value::Null).await;
}

#[tokio::test]
#[should_panic(expected = "isn't registered")]
async fn the_permission_test_catches_a_command_that_isnt_there() {
    assert_missing_permission_refused(Sample { slow_ms: 0 }, "sample.nope", Value::Null).await;
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-testkit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn goldens_compare() {
    let d = tmp("goldens");
    std::fs::write(d.join("a.json"), "{\n  \"x\": 1\n}\n").unwrap();
    assert_golden_at(&d, "a", &json!({ "x": 1 }));
    let r = std::panic::catch_unwind(|| assert_golden_at(&d, "a", &json!({ "x": 2 })));
    assert!(r.is_err(), "a different value fails");
    let r = std::panic::catch_unwind(|| assert_golden_at(&d, "missing", &json!({})));
    assert!(
        r.is_err(),
        "a missing golden fails and says how to write it"
    );
}

fn run(
    bin: &std::path::Path,
    args: &[&str],
    cwd: &std::path::Path,
    stdin: &str,
    env: &[(&str, &str)],
) -> (i32, String, String) {
    use std::io::Write;
    let mut c = std::process::Command::new(bin);
    c.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let o = child.wait_with_output().unwrap();
    (
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stdout).into_owned(),
        String::from_utf8_lossy(&o.stderr).into_owned(),
    )
}

#[test]
fn the_fake_harness_plays_claude_and_codex() {
    let d = tmp("agent");
    let bin = d.join("bin");
    install_fakes(&bin, &["claude", "codex", "gh"]).unwrap();
    let work = d.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(
        work.join("math.js"),
        "export const add = (a, b) => a - b;\n",
    )
    .unwrap();
    let (code, out, _) = run(&bin.join("claude"), &["--version"], &work, "", &[]);
    assert_eq!((code, out.trim()), (0, "9.9.9 (Fake Claude Code)"));
    let rec = d.join("rec");
    let rec_s = rec.display().to_string();
    let (code, out, _) = run(
        &bin.join("claude"),
        &["-p", "--output-format", "stream-json"],
        &work,
        "fix it TOPIC[Math fix]",
        &[("FAKE_RECORD", &rec_s)],
    );
    assert_eq!(code, 0);
    let lines: Vec<Value> = out
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines[0]["subtype"], "init");
    let result = lines.last().unwrap();
    assert_eq!(result["type"], "result");
    assert!(
        result["result"]
            .as_str()
            .unwrap()
            .contains("\"topic\":\"Math fix\"")
    );
    assert!(
        std::fs::read_to_string(work.join("math.js"))
            .unwrap()
            .contains("a + b")
    );
    let recorded: Value = serde_json::from_str(
        std::fs::read_to_string(rec.join("claude.jsonl"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(recorded["stdin"], "fix it TOPIC[Math fix]");
    let (code, out, _) = run(&bin.join("codex"), &["exec", "--json"], &work, "go", &[]);
    assert_eq!(code, 0);
    assert!(out.lines().last().unwrap().contains("turn.completed"));
    let (code, _, err) = run(
        &bin.join("claude"),
        &["-p"],
        &work,
        "go",
        &[("FAKE_FAIL", "1")],
    );
    assert_eq!(code, 1);
    assert!(err.contains("failed on purpose"));
}

#[test]
fn the_fake_gh_keeps_pull_requests() {
    let d = tmp("gh");
    let bin = d.join("bin");
    install_fakes(&bin, &["gh"]).unwrap();
    let state = d.join("state.json").display().to_string();
    let env = [("FAKE_GH_STATE", state.as_str())];
    let gh = bin.join("gh");
    let (code, out, _) = run(
        &gh,
        &[
            "pr", "create", "--title", "T", "--body", "B", "--head", "feat/x", "--base", "main",
        ],
        &d,
        "",
        &env,
    );
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("https://github.com/acme/repo/pull/1"));
    let (_, out, _) = run(&gh, &["pr", "view", "1", "--json", "state"], &d, "", &env);
    let pr: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(
        (pr["state"].as_str(), pr["headRefName"].as_str()),
        (Some("OPEN"), Some("feat/x"))
    );
    run(&gh, &["pr", "merge", "feat/x", "--squash"], &d, "", &env);
    let (_, out, _) = run(&gh, &["pr", "view", "1"], &d, "", &env);
    assert_eq!(
        serde_json::from_str::<Value>(out.trim()).unwrap()["state"],
        "MERGED"
    );
    let (code, _, err) = run(&gh, &["pr", "view", "9"], &d, "", &env);
    assert_eq!((code, err.trim()), (1, "no pull requests found"));
    let _ = Arc::new(());
}
