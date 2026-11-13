//! Gate G6 (plan §9.1): 34 recorded Claude Code runs parse exactly as v1 parsed them. Each fixture is
//! the CLI's stdout (`<name>.jsonl`, the run's folder as @CWD@), its exit and run options
//! (`<name>.meta.json`) and what v1's adapter reported for those bytes (`<name>.v1.json`). As v1's
//! replay did, @CWD@ becomes a folder and the events say @CWD@ again; the disk is empty, as the
//! folder v1 replayed in was.

use std::path::Path;

use serde_json::Value;
use wisp_claude_core::{ClaudeOptions, ClaudeParser};
use wisp_harness_kit::{Exit, HarnessEvent, NoDisk, RunPaths, js, replay};

/// The folder the runs replay in (any absolute path: the disk is never read).
const CWD: &str = "/tmp/wisp-g6-run";

fn read(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
}

/// JSON equality with numbers compared as numbers (v1's 5 and our 5.0 are the same).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn drop_path(v: &mut Value, path: &[&str]) {
    match path {
        [] => {}
        [last] => {
            if let Some(o) = v.as_object_mut() {
                o.remove(*last);
            }
        }
        [head, rest @ ..] => {
            if let Some(next) = v.get_mut(*head) {
                drop_path(next, rest);
            }
        }
    }
}

/// The exit a fixture's process had: ones with `stopAfter` were stopped by the user (edge case 9:
/// the stop is its own flag, whatever the exit code says).
fn exit_of(meta: &Value) -> Exit {
    let e = &meta["exit"];
    let stopped = meta.get("stopAfter").is_some();
    Exit {
        code: e["code"].as_i64().and_then(|c| i32::try_from(c).ok()),
        signal: e["signal"].as_str().map(str::to_owned),
        // v1's spawnJsonl kept the trimmed tail of stderr
        stderr: js::trim(e["stderr"].as_str().unwrap_or("")).to_owned(),
        stopped: stopped || matches!(e["signal"].as_str(), Some("SIGTERM" | "SIGINT")),
        stop_requested: stopped,
    }
}

/// The events of one fixture as JSON (after `meta.drop`), and v1's golden.
fn run_fixture(dir: &Path, name: &str) -> Option<(Vec<Value>, Vec<Value>)> {
    let meta: Value = serde_json::from_str(&read(&dir.join(format!("{name}.meta.json")))?).ok()?;
    let stdout = read(&dir.join(format!("{name}.jsonl")))?.replace("@CWD@", CWD);
    let opts = &meta["opts"];
    let mut parser = ClaudeParser::new(ClaudeOptions {
        paths: RunPaths::same(CWD),
        prior: opts.get("prior").cloned(),
        unknown_prior: opts["unknownPrior"].as_bool().unwrap_or(false),
    });
    let lines: Vec<&str> = stdout.lines().collect();
    let events = replay(&mut parser, &lines, &exit_of(&meta), &mut NoDisk, |i| i64::try_from(i).unwrap_or(0));
    let text = serde_json::to_string(&events.iter().map(HarnessEvent::to_json).collect::<Vec<_>>()).ok()?.replace(CWD, "@CWD@");
    let mut got: Vec<Value> = serde_json::from_str(&text).ok()?;
    let drops: Vec<&str> = meta["drop"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for e in &mut got {
        for d in &drops {
            drop_path(e, &d.split('.').collect::<Vec<_>>());
        }
    }
    let golden: Vec<Value> = serde_json::from_str(&read(&dir.join(format!("{name}.v1.json")))?).ok()?;
    Some((got, golden))
}

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// The named fixtures parse as v1 did (the edge cases of docs/v1-edge-cases.md, "Harness runners").
fn as_v1(names: &[&str]) {
    for name in names {
        let (got, want) = run_fixture(&fixtures(), name).unwrap_or_default();
        assert!(!want.is_empty() && got.len() == want.len() && got.iter().zip(&want).all(|(a, b)| same(a, b)), "{name}");
    }
}

#[test]
fn edge_1_resume_holds_the_early_result_but_a_compaction_is_final() {
    as_v1(&["orphans", "compact", "compact-real", "compact-none", "context-compact"]);
}

#[test]
fn edge_2_counters_count_the_prior_turn_only_when_they_grew() {
    as_v1(&["restored", "restored-zero", "unknown-prior"]);
}

#[test]
fn edge_4_background_tasks_keep_the_turn_open() {
    as_v1(&["background", "background-done", "background-exit"]);
}

#[test]
fn edge_9_a_stop_is_its_own_flag() {
    // stopped after the early result: it is dropped, and the turn ends stopped
    as_v1(&["hang-stop", "orphans-only"]);
}

#[test]
fn g6_every_recorded_run_parses_as_v1_did() {
    let dir = fixtures();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|r| {
            r.filter_map(Result::ok)
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".jsonl")).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    assert_eq!(names.len(), 34, "the 34 recorded runs");
    let mut failed = Vec::new();
    for name in &names {
        let Some((got, want)) = run_fixture(&dir, name) else {
            failed.push(format!("{name}: unreadable fixture"));
            continue;
        };
        if !(got.len() == want.len() && got.iter().zip(&want).all(|(a, b)| same(a, b))) {
            let at = got.iter().zip(&want).position(|(a, b)| !same(a, b)).unwrap_or(got.len().min(want.len()));
            let show = |v: Option<&Value>| v.map_or_else(|| "-".into(), Value::to_string);
            failed.push(format!(
                "{name}: {} events, v1 had {}; first difference at #{at}:\n  got  {}\n  want {}",
                got.len(),
                want.len(),
                show(got.get(at)),
                show(want.get(at))
            ));
        }
    }
    eprintln!("G6: {}/34 recorded Claude runs match v1", 34 - failed.len());
    assert!(failed.is_empty(), "G6: {}/34 match v1\n{}", 34 - failed.len(), failed.join("\n"));
}
