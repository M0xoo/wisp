# Harness parser throughput (ADR-0011, plan §8)

**What:** `wisp-claude-core`'s stream-json parser over 50,000 lines made by cycling the 34 recorded Claude
runs (`plugins/claude/core/tests/fixtures`) in order: 23.4k assistant, 10.7k system, 9.6k user, 5.8k
result and 0.5k rate-limit lines, 12.0 MB, 99,667 events out. Each recorded run gets a fresh parser, as
one process would; events are collected and dropped as the driver would.

```sh
cargo test --release -p wisp-claude-core --test bench bench_parser_throughput -- --ignored --nocapture
# CPU time instead of wall time on a busy machine:
BENCH_ITERS=40 /usr/bin/time -p <bench binary> bench_parser_throughput --ignored --exact
BENCH_WHAT=scan BENCH_ITERS=40 /usr/bin/time -p <bench binary> bench_floor --ignored --exact
```

**Machine:** Apple M2 (4P + 4E), macOS 15.6 (Darwin 24.6), rustc 1.99.1, release profile (fat LTO),
shared with other agents' builds (load average 8 to 70 during the runs; the numbers below are from a
load ≈ 8 window, best of 30).

| | lines/s | MB/s | per 50k lines |
|---|---|---|---|
| v1 (Node, `adapters/claude.js`) | 277,000 | | |
| first Rust port (a `serde_json::Value` per line) | 339,000 | 82 | 147 ms |
| + borrowed raw `message`, typed parts | 572,000 | 138 | 87 ms |
| + content parts and usage in one pass, no per-message `Value` | **~805,000** | **194** | **62 ms** |
| floor: `serde_json` scanning the bytes into nothing (`IgnoredAny`) | ~3,800,000 | ~900 | 13 ms CPU |

**Target ≥ 1,000,000 lines/s: not met** (0.8×; 2.9× v1). The profile (macOS `sample`, symbolised build)
puts the rest in serde_json's string scanning and unescaping, malloc/free for the owned strings every
event carries (one `session` event per line, as v1 had), and `memmove` of those strings. Next levers,
each a decision for the lead: events that borrow their text (`Bytes`/`Arc<str>` in `HarnessEvent`,
a contract change), or a SIMD JSON scanner (a new dependency, so an ADR).

`describe_command` (the ticker label of a shell command), same machine: the 10,047-command corpus in
`crates/wisp-harness-kit/tests/fixtures/commands.v1.json` (many long generated command lines) runs at
~244,000 commands/s (`bench_describe_command`); it runs once per shell tool call, not per line.
