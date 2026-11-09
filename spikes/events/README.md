# events bench (ADR-0044)

`cargo run --release --manifest-path spikes/events/Cargo.toml` measures the durable event log against the
budgets in `tools/budgets.ts` (`EVENT_BUDGETS`) and exits non-zero when one is missed:

- emit → in-process handler, p99 ≤ 1 ms (an ephemeral event, no store)
- durable append ≥ 20 000 events/s (the log, 1 000 a transaction), and one durable event per command
  carried by the command's own write (reported)
- replay of 100 000 events to a durable subscription ≤ 1 s

Not measured here: the `events:*` topic's p99 to a client (`spikes/sync-bench-rs` measures the topic path it
rides on) and write amplification (stream events stay ephemeral, so the streaming bench doesn't change).
