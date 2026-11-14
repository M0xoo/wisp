//! Parser throughput (ADR-0011, plan §8): 50,000 stream-json lines made by cycling the 34 recorded runs
//! in order (a realistic mix: init, assistant text and tool calls, tool results, rate-limit events,
//! results), each run through a fresh parser as one process would be, events collected as the driver
//! would. v1 parsed 277k lines/s in Node; the target is ≥ 1M/s.
//!
//! `cargo test --release -p wisp-claude-core --test bench -- --ignored --nocapture`

use std::path::Path;
use std::time::Instant;

use wisp_claude_core::{ClaudeOptions, ClaudeParser};
use wisp_harness_kit::{Exit, LineParser, Out, RunPaths};

const LINES: usize = 50_000;

fn runs() -> Vec<Vec<String>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .map(|r| r.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect())
        .unwrap_or_default();
    names.sort();
    names
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .map(|t| t.replace("@CWD@", "/tmp/w").lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect())
        .collect()
}

#[test]
#[ignore = "a measurement, not a check"]
fn bench_parser_throughput() {
    let runs = runs();
    // Whole runs, in order, until 50k lines.
    let mut chunks: Vec<&[String]> = Vec::new();
    let mut n = 0;
    'fill: loop {
        for r in &runs {
            let take = r.len().min(LINES - n);
            chunks.push(&r[..take]);
            n += take;
            if n == LINES {
                break 'fill;
            }
        }
    }
    let bytes: usize = chunks.iter().flat_map(|c| c.iter()).map(|l| l.len() + 1).sum();
    let mut best = f64::MAX;
    let mut events = 0;
    // Best of many: the machine is shared, and the fastest run is the one nothing else got in the way of.
    // BENCH_ITERS=0 loads the fixtures only, so `time` over 0 and N runs gives the CPU time per run on a
    // loaded machine (wall time there mostly measures the scheduler).
    let iters: usize = std::env::var("BENCH_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    for _ in 0..iters {
        let t = Instant::now();
        let mut out: Vec<Out> = Vec::with_capacity(64);
        events = 0;
        for chunk in &chunks {
            let mut p = ClaudeParser::new(ClaudeOptions { paths: RunPaths::same("/tmp/w"), ..ClaudeOptions::default() });
            for line in *chunk {
                p.line(line, 0, &mut out);
                events += out.len();
                out.clear();
            }
            p.close(&Exit::clean(), 0, &mut out);
            events += out.len();
            out.clear();
        }
        best = best.min(t.elapsed().as_secs_f64());
    }
    #[allow(clippy::cast_precision_loss)]
    let (lps, mbs) = (LINES as f64 / best, bytes as f64 / best / 1e6);
    #[allow(clippy::cast_precision_loss)]
    let mb = bytes as f64 / 1e6;
    eprintln!("claude parser: {LINES} lines ({:.1} MB, {events} events) in {:.2} ms = {:.0} lines/s, {mbs:.0} MB/s", mb, best * 1e3, lps);
    assert!(iters == 0 || lps > 0.0);
}

/// The floor: `serde_json` scanning the same 50k lines into nothing, and the parser's own line read,
/// in CPU time per run with `BENCH_ITERS` (as above). `BENCH_WHAT=scan|line`.
#[test]
#[ignore = "a measurement, not a check"]
fn bench_floor() {
    let runs = runs();
    let lines: Vec<&String> = runs.iter().flatten().cycle().take(LINES).collect();
    let iters: usize = std::env::var("BENCH_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    let line = std::env::var("BENCH_WHAT").is_ok_and(|w| w == "line");
    let mut n = 0;
    for _ in 0..iters {
        for l in &lines {
            n += if line {
                usize::from(wisp_claude_core::line::Line::parse(l).is_some())
            } else {
                usize::from(serde_json::from_str::<serde::de::IgnoredAny>(l).is_ok())
            };
        }
    }
    assert!(iters == 0 || n > 0);
}
