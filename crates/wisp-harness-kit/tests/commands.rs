//! Gate G6 for ticker labels: `describe_command` says exactly what v1's describeCommand said, over every
//! command string in v1's tests and fake CLIs plus a generated corpus that walks each branch v1 has
//! (`fixtures/gen-commands.mjs` recorded v1's answers: 10,047 commands, each in three cwd forms).

use std::path::Path;
use std::time::Instant;

use serde_json::Value;
use wisp_harness_kit::{RunPaths, describe_command};

struct Run {
    cwd: String,
    real: String,
    paths: RunPaths,
}

fn load() -> (Vec<Run>, Vec<Value>) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/commands.v1.json");
    let v: Value = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let s = |x: &Value| x.as_str().unwrap_or("").to_owned();
    let runs = v["runs"]
        .as_array()
        .map(|a| a.iter().map(|r| Run { cwd: s(&r["sub"]["cwd"]), real: s(&r["sub"]["real"]), paths: RunPaths::new(s(&r["paths"]["cwd"]), s(&r["paths"]["real"])) }).collect())
        .unwrap_or_default();
    (runs, v["cases"].as_array().cloned().unwrap_or_default())
}

#[test]
fn every_recorded_command_reads_as_v1_did() {
    let (runs, cases) = load();
    assert_eq!((runs.len(), cases.len()), (3, 10_047), "the recorded corpus");
    let mut bad = Vec::new();
    let mut checked = 0;
    for case in &cases {
        let Some(cmd) = case[0].as_str() else { continue };
        let one = case.as_array().map_or(0, Vec::len) == 2; // one answer when the three runs agree
        for (i, run) in runs.iter().enumerate() {
            let want = case.get(if one { 1 } else { i + 1 }).and_then(Value::as_str).unwrap_or("");
            let input = cmd.replace("@CWD@", &run.cwd).replace("@REAL@", &run.real);
            let got = describe_command(&input, &run.paths);
            checked += 1;
            if got != want {
                bad.push(format!("[run {i}] {input:?}\n    want {want:?}\n    got  {got:?}"));
            }
        }
    }
    eprintln!("describe_command: {checked} cases checked, {} differ from v1", bad.len());
    assert_eq!(checked, 3 * 10_047);
    assert!(bad.is_empty(), "{} of {checked} differ from v1:\n{}", bad.len(), bad.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn v1_unit_cases() {
    // test/commands.test.js
    let p = RunPaths::same("/repo");
    for (cmd, want) in [
        ("sed -n 15,50p src/a.js", "Reading lines 15–50 of src/a.js"),
        ("git status", "Checking git status"),
        ("npm test", "Running tests"),
        ("cd /repo && npm run build", "Building the project"),
        ("curl -s https://example.com", "Fetching example.com"),
        ("while", "Running while"),
        ("", "Running "),
    ] {
        assert_eq!(describe_command(cmd, &p), want, "{cmd}");
    }
}

/// Throughput over the whole corpus: `cargo test --release -p wisp-harness-kit --test commands -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, not a check"]
fn bench_describe_command() {
    let (runs, cases) = load();
    let inputs: Vec<String> = cases.iter().filter_map(|c| c[0].as_str()).map(|c| c.replace("@CWD@", &runs[0].cwd).replace("@REAL@", &runs[0].real)).collect();
    let mut best = f64::MAX;
    for _ in 0..5 {
        let t = Instant::now();
        let n: usize = inputs.iter().map(|i| describe_command(i, &runs[0].paths).len()).sum();
        assert!(n > 0);
        best = best.min(t.elapsed().as_secs_f64());
    }
    #[allow(clippy::cast_precision_loss)]
    let rate = inputs.len() as f64 / best;
    eprintln!("describe_command: {} commands in {:.1} ms = {:.0} commands/s", inputs.len(), best * 1e3, rate);
}
