# G3: sync fan-out, Rust (`crates/wisp-sync`)

4 clients, 10 running tasks for 120 s, v1's broadcast against v2's topic outbox. The workload is
`spikes/sync-bench/g3.ts`'s, event for event (the same JS LCG), so the numbers compare with the TS run.

```sh
cargo run --release --manifest-path spikes/sync-bench-rs/Cargo.toml -- --seconds=120 --seed=1
```

Pass: v2 sends ≥ 5× fewer bytes than v1 with a task open on every client, and uses no more CPU.
CPU is the fan-out only, timed in-process (v1: stringify + 4 writes per broadcast; v2:
`SyncServer::handle` + framing).

## Results (2026-11-08, M-series Mac, release build, 3 runs)

| run | bytes | frames | fan-out CPU | vs v1 |
|---|---|---|---|---|
| v1 broadcast | 6.84 MB | 10 912 | 7.5–10.6 ms | |
| v2 list only | 0.96 MB | 3 952 | 2.9–3.9 ms | 7.1× fewer bytes |
| v2 list + 1 open task | 1.34 MB | 4 179 | 3.8–4.2 ms | 5.1× fewer bytes |

Bytes match the TS reference (6.84 MB v1 / 1.34 MB v2) to the hundredth: the workload is the same.
