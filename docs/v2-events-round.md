# v2 round: the setup probe, and ADR-0044 (events: one log, two speeds) — 2026-11-09

By concern. ADR-0044's 15 named edge cases each have a test (listed at the end). ADR-0043 isn't started: it
builds on this, and starting it half-way would leave stubs.

## 0. The setup probe (ADR-0029)

- **A timed-out probe says so.** `ExecResult.timed_out` now records `why: "timed out after 5 s"`, not "it didn't
  answer initialize". The test `a_probe_that_times_out_says_so` uses a server that sleeps (`serve_setup.rs`).
- **The flaky run under load was real: output was lost, in `wisp-proc`.** After a child exited, `pipes::drain`
  gave its output readers 300 ms of wall time and then aborted them.
  - Under a loaded runtime (the full suite), a reader that hadn't been scheduled yet lost output still sitting
    in the pipe. The 2-line `sh` server's answer was gone before anyone read it.
  - It wasn't the probe cache, and it wasn't EPIPE: input errors were already ignored.
  - **Fix:** once the child is gone, each read times out only after 300 ms idle, through `tokio::time::timeout`,
    which polls the read first. Data already in the pipe is always read, however late the task runs. A 5 s
    total cap after the exit keeps a grandchild that keeps writing from holding `exec` for ever.
  - **Test:** `output_already_written_survives_a_late_reader` holds the pipe open and first polls the reader
    3 × 300 ms after the exit. The existing grandchild test still passes.
  - **Bench:** `wisp-proc` `output_throughput`, before and after, gives pipes 3.30 GB/s against 3.28–3.30 GB/s
    (3 runs). The PTY is unchanged at 102 MB/s.

## 1. ADR-0044: events

**Kernel (`crates/wisp-kernel/src/durable.rs`; additive to the frozen contract)**
- **`Event` additions:** `Event::DURABLE`, plus `subject()` and `key()` (both default `None`).
- **Subscriptions:** `Setup::on_durable::<E>(name, f)` delivers `Durable<E>`, which is `Event{event, seq, key}`
  or `Gap{from, to}`. `on_durable_any(name, glob, f)` does the same for envelopes.
- **Causation:** `Call::cause()` and `Call::cause_depth()`.
- **Other `Ctx` and envelope additions:** `Ctx::emit_versions` (a `@2` type and its old type together),
  `Ctx::event_log`, `Ctx::retry_event` and `Ctx::manifests`. Envelopes carry `durableSeq`, `subject`, `key`,
  `cause` and `depth`.
- **The `EventLog` service trait:** the store implements it and `wisp serve` provides it. Without one, durable
  events act like ephemeral ones.
- **Delivery:**
  - Recent durable envelopes sit in a ring of 8 192. Each subscription has one worker, which takes `cursor + 1`
    from the ring, or reads the table when behind. One writer keeps seqs contiguous, so a worker never skips one.
  - A worker's cursor rides on the handler's store writes, in the same transaction. A handler that writes
    nothing has its cursor saved every 256 deliveries and whenever the worker catches up.
  - Retries: 3, then the event is parked with why and the cursor moves on. A handler whose write already
    committed isn't retried.
  - `Kernel::idle` counts a durable worker as busy until it catches up, under the same lock that raises the
    head, so it never resolves between an event and its delivery.
- Durable workers start only after their plugin's `on_start` (its tables exist by then).

**Store (`crates/wisp-store/src/events.rs`)**
- **Tables:** `event`, `event_cursor` and `event_parked`, added as kernel migration 2. `event` is rowid-only,
  with zstd above 1 KB.
- **The command's transaction:** `Store::write` carries the running command's durable events, and the
  handler's cursor, in the same transaction. A rollback drops them.
- **Dedupe:** one `(type, key)` per 24 h, using keys kept in memory and read back at open.
- **Retention:** 30 days or 1 M rows, trimmed at open and every 10 k appends.

**Durable types** (by the ADR's rule; each with a subject and a dedupe key)
- `turn.finished`, `turn.ended`, `turn.held`, `session.asked`, `pr.opened`, `pr.merged`, `review.finished`,
  `later.fired` and `crew.job_filed`.
- `goal.met`/`failed`, `crew.reported`, CI and issue events, and `trigger.fired` don't exist as events yet;
  ADR-0043 adds the trigger one.

**`wisp.events` (new plugin, `plugins/events/{api,host}`)**
- **Commands:** `events.tail` (a capped agent sees only its own task's events, and asking for another's is
  refused), `events.why`, `events.retry`, `events.parked`, `events.ls` (the catalogue), `events.sinksStatus`
  and `events.resume`.
- **The topic:**
  - The `events:<glob>` topic is a durable view of the last 5 000 events. Each row sits on `events:*`,
    `events:<area>.*` and `events:<type>`, so it resumes from a client cursor like any topic.
  - The topic grammar was extended in wisp-protocol, `@wisp/protocol` `isTopic` and the store, and the
    bindings were regenerated. No protocol snapshot exists yet, and the tool says to write one only at a
    release.
- **MCP:** `wisp_events`, plus the generated `events_*` tools. `wisp.mcp` now declares `events:tail` and
  `events:why`, and `agent:session` allows them.
- **Sinks:**
  - `events.sink@1` ships with a webhook sink, configured by the `events.sinks` setting.
  - It signs with `x-wisp-signature: sha256=…` (GitHub's scheme), tries each event, then once per wait in
    `backoffMs`, and pauses after `pauseAfter` events fail every try.
- **CLI:** `wisp events tail [--type] [--subject] [--since] [--limit] [--follow] [--json]`, plus
  `wisp events why|retry|parked|ls`.
- **Telemetry:** `turn.ended` is now a durable subscription.

**Catalogue and check**
- **Manifests:** `contributes.events` takes `{type, durable, title, subject, key}`. Types are named by area
  (`pr.opened`), so namespace ownership isn't enforced for them. All 17 plugins that emit events now list
  them: 60 types.
- **The `tools/check` rule (`rust-events`):** an emitted type missing from its manifest fails, as does a listed
  type that nothing emits, durable not matching the code, or a `@2` type without its old one.

**Budgets** (`tools/budgets.ts` `EVENT_BUDGETS`, gated by `spikes/events`, which exits 1 on a miss)

| Budget | Limit | Measured |
|---|---|---|
| emit → handler, p99 | ≤ 1 ms | 0.010 ms |
| durable append | ≥ 20 k/s | 1.13 M/s, 1 000 per transaction |
| replay of 100 k | ≤ 1 s | 245 ms |
| one durable event per command, in its own transaction | (reported) | 48 k/s |

The replay was 1.86 s before the cursor saving above. The topic's p99 is the sync path's, which
`sync-bench-rs` measures. Write amplification is unchanged, since stream events stay ephemeral.

**Not built**
- **JSON Schemas in the catalogue (schemars):** `events.ls` gives the type, whether it's durable, the plugin and
  the title, but no schema yet.
- **The SDK's `wisp.events()`:** TypeScript, with the client work.
- **Whole-glob topics:** only `*`, `<area>.*` and `<type>` are topics. `wisp events tail --type '*.finished'`
  works, but `--follow` doesn't take that form.
- **Delivery order:**
  - A durable event emitted outside a command reaches in-process subscribers before it's appended, so a repeat
    within 24 h still reaches in-process subscribers once.
  - If a command commits a write and then returns an error, its durable events are in the log for durable
    subscribers, but not published to in-process ones.

## Edge cases → tests

| # | Test | Where |
|---|---|---|
| 1 | `durable_event_rolled_back_with_its_command_is_never_seen` | wisp-store/tests/durable_events.rs |
| 2 | `restart_replays_from_cursor_without_loss_or_duplicate_effect` | same |
| 3 | `crash_between_handler_write_and_cursor_cannot_happen` | same |
| 4 | `lagging_durable_subscriber_reads_the_table_then_rejoins_live_in_order` | same |
| 5 | `lagging_ephemeral_subscriber_drops_and_records_diag` | wisp-kernel/tests/kernel_events.rs (renamed) |
| 6 | `cursor_past_retention_gets_gap_and_resyncs_state` | wisp-store/tests/durable_events.rs |
| 7 | `same_type_and_key_within_24h_recorded_once` | same |
| 8 | `causation_chain_depth_cuts_trigger_loops_at_3` (depths tracked; the cut is ADR-0043's) | same |
| 9 | `plugin_switched_off_keeps_its_cursor_and_resumes_on_again` | same |
| 10 | `capped_agent_sees_only_its_task_events_over_mcp` | crates/wisp/tests/serve_events.rs |
| 11 | `sink_webhook_signed_retried_with_backoff_and_paused_after_failures` | same |
| 12 | `emitted_type_missing_from_manifest_fails_check` | tools/check/test/rust.test.ts |
| 13 | `event_v2_type_and_v1_type_both_emitted_for_one_minor` | wisp-kernel/tests/kernel_events.rs |
| 14 | `topic_events_resumes_from_client_cursor` | crates/wisp/tests/serve_events.rs |
| 15 | `handler_panic_retried_3_times_then_parked_with_reason` | wisp-store/tests/durable_events.rs |
