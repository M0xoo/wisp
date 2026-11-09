# ADR-0044: Events: one log, two speeds (no separate bus)

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "think about the event system in wisp (an event bus or something?), the best way to handle
  events for performance and clarity". Builds on ADR-0003 (events as a contract), ADR-0004 (one write path),
  ADR-0005 (sync by cursor), ADR-0011 (budgets) and ADR-0043 (triggers consume events).

## What exists (kept)

The kernel already has an in-process bus (`crates/wisp-kernel/src/events.rs`), and it's a good one:
- **Typed and zero-copy:** an `Arc<dyn AnyEvent>`. In-process subscribers of the same type never touch JSON.
- **Published after commit:** an event never describes a write that rolled back.
- **One bounded queue per subscribing plugin:** a slow plugin only delays itself.
- **At least once:** 3 tries, deduped by `seq`.
- **Fast matching:** an exact-type index plus glob patterns.

It's the right shape for reactions inside one process. Adding NATS, Redis or a broker would add a process, a
second source of truth and a network hop to a local-first app. We don't add one.

## What's missing

1. **Events die with the process.** A restart, or a subscriber past `QUEUE_CAP`, loses events. "It catches up
   from the change feed" is lossy: the feed holds rows, not facts (`task.finished` isn't recoverable from a patch).
   Triggers and crew wakes (ADR-0043) can't miss a `pr.review_requested` because wisp restarted.
2. **No catalogue.** The 45 event types are Rust structs, but nothing lists them with their schemas, so the
   triggers editor, the docs, the SDKs and MCP can't offer them.
3. **No causation.** An event doesn't know which event caused the command that emitted it, so trigger loops are
   cut by lineage heuristics.
4. **Nothing outside the process can listen:** not the CLI, not an outside harness, not CI, not a peer.

## Decision

### Two speeds, one API

`Event` gets an additive const: **`const DURABLE: bool = false`**.

| | Ephemeral (default) | Durable |
|---|---|---|
| Examples | stream deltas, progress, presence, `automations.changed` | `task.finished`, `task.failed`, `pr.opened`, `goal.met`, `crew.reported`, `trigger.fired` |
| Stored | no | yes: appended to the `event` table **in the emitting command's transaction** (transactional outbox) |
| Delivery | the in-process queue (today) | the in-process queue first (same latency), then a durable cursor per subscription |
| After a restart or lag | dropped, recorded in diag | the subscriber replays from its cursor: no loss |
| Seen outside | no | sync topic, CLI, MCP, SDK, sinks (below) |

Rule of thumb: an event is durable when **someone would be upset to miss it**: a lifecycle fact a user or
automation acts on. Anything emitted many times a second stays ephemeral. Making an event durable is a
deliberate change in its `api` crate, reviewed against the write budget.

### The `event` table (wisp-store)

`event(seq INTEGER PRIMARY KEY, type TEXT, plugin TEXT, subject TEXT, key TEXT, cause INTEGER, root TEXT, at
INTEGER, data BLOB)` STRICT, rowid only, no secondary index (same reasoning as `change`: every index costs WAL
pages). `data` is compact JSON, zstd above 1 KB. `subject` is what it's about (a task, a PR). `key` is the
dedupe key; a repeated `(type, key)` within 24 h is recorded once.

**Retention:** 30 days or 1 M rows, whichever is first. A durable subscriber whose cursor falls off the end
is told `gap` (it re-reads current state) and diag records it.

### Durable subscriptions

- `s.on_durable::<E>(name, f)`: the subscription has a stable name.
- Its cursor lives in `event_cursor(plugin, name, seq)`.
- When the handler runs commands, the cursor advances **in the same transaction as the handler's last write**.
  The outcome is effectively once: a crash before commit replays, and after it doesn't.
- Handlers stay idempotent anyway: the envelope carries `seq` and `key`.
- The live path is unchanged: a durable event reaches the in-process queue at once. The table is read only on
  start, on lag or after a gap, and the reader resumes from `max(cursor)`. No polling.

### Causation

Every call carries `cause: Option<seq>`, the durable event whose handler started it. Events emitted in that call
record it, which gives a chain `event → command → event`. Triggers (ADR-0043) cut loops by chain depth (3), and
`wisp events why <seq>` prints the chain. Lineage `triggeredBy` stays the user-facing record.

### The catalogue

- Each plugin manifest lists its events under `contributes.events`: type, `durable`, `subject`, `key`, a one-line
  title and the JSON Schema (generated from the Rust type by schemars).
- `tools/check` fails when an emitted type is missing from its manifest, or the manifest lists a type nobody emits.
- The catalogue feeds:
  - the triggers editor: **every durable event is a trigger source automatically**, as `on: <type>` with its
    schema's fields as filters. `trigger.source@1` stays for external and polled sources.
  - the docs reference (ADR-0039) and the SDK types;
  - `wisp events ls`.
- Naming: `<area>.<noun>.<past-verb>` (`task.finished`, `pr.review_requested`). Breaking a payload means a new
  type (`task.finished@2`); the old one keeps being emitted for one minor.

### Outside the process (ADR-0040)

| Where | How |
|---|---|
| Clients and peers | the sync topic `events:<glob>`, served from the `event` table by cursor (no second protocol) |
| CLI | `wisp events tail [--type glob] [--subject id] [--since]`, `wisp events why <seq>` |
| Outside harnesses | MCP `wisp_events` (read; a capped agent sees its own task's events only, as with reads today) |
| SDK | `for await (const e of wisp.events({ type: 'pr.*' }))` |
| Other systems | **`events.sink@1`**: forward matching durable events to an HTTP webhook (signed), ntfy, Slack and so on, each a plugin, same capability rules |
| Telemetry | `wisp.telemetry` is one durable subscriber with its own sinks (ADR-0021): no separate path |

### Not events

- **Interceptors** stay the synchronous "before" path that may veto. Events are only "after": they never veto
  and never block the emitter.
- **Row changes** stay in the `change` feed for sync. An event isn't a row diff, and a row diff isn't an event.
  Don't emit `x.updated` events that duplicate a topic.

## Performance

- The in-process path is unchanged: no serialisation, one Arc per subscriber.
- The durable path adds one row append inside a transaction the command already opens: no extra fsync. It's
  serialised once at commit.
- Budgets (added to `tools/budgets.ts`), each measured by a bench in `spikes/events/`:
  - emit → in-process handler p99 ≤ 1 ms;
  - durable append ≥ 20 k/s;
  - write amplification stays ≤ 15× on the streaming bench, because stream events aren't durable;
  - replay of 100 k events ≤ 1 s;
  - `events:*` topic to a client p99 ≤ 150 ms.

## Edge cases (one named test each)

1. `durable_event_rolled_back_with_its_command_is_never_seen`
2. `restart_replays_from_cursor_without_loss_or_duplicate_effect`
3. `crash_between_handler_write_and_cursor_cannot_happen`: same transaction (fault injection)
4. `lagging_durable_subscriber_reads_the_table_then_rejoins_live_in_order`
5. `lagging_ephemeral_subscriber_drops_and_records_diag`
6. `cursor_past_retention_gets_gap_and_resyncs_state`
7. `same_type_and_key_within_24h_recorded_once`
8. `causation_chain_depth_cuts_trigger_loops_at_3`
9. `plugin_switched_off_keeps_its_cursor_and_resumes_on_again`
10. `capped_agent_sees_only_its_task_events_over_mcp`
11. `sink_webhook_signed_retried_with_backoff_and_paused_after_failures`
12. `emitted_type_missing_from_manifest_fails_check`
13. `event_v2_type_and_v1_type_both_emitted_for_one_minor`
14. `topic_events_resumes_from_client_cursor`
15. `handler_panic_retried_3_times_then_parked_with_reason` (durable: parked, not lost; `wisp events retry`)

## Consequences

- One mental model: commands write, events say what happened after commit, interceptors say no first, topics
  show state.
- ADR-0043's engine becomes a durable subscriber per trigger. It needs no polling for internal sources, and no
  restarts lose wakes.
- The kernel gets `DURABLE`, `on_durable`, `cause`, and the store gets `event`/`event_cursor`. All of it is
  additive to the frozen contract (the `change-a-contract` skill).
- Builds together with ADR-0043, first: the engine is its first durable consumer.
