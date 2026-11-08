# ADR-0021: Analytics are a pipeline with pluggable sinks; PostHog is one module

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "keep v1's PostHog events, and make it easy to plug in other events or analytics later."

## Decision

- **`wisp.telemetry` owns the pipeline, not the vendor:** the event catalogue (typed events, their
  properties, versioned), opt-out and environment rules, scrubbing, sampling, batching and the distinct id.
  Its `api` crate exports:
  - `Track` (a command): what plugins and the UI call to record an event. A UI call is checked against the
    catalogue's allow-list for UI-originated events.
  - `telemetry.event` (an event published after scrubbing and sampling, plus the opt-out check), which any
    plugin may subscribe to.
  - **`telemetry.sink@1`** (a list point): `{ id, send(batch) }`. Every enabled sink gets the same scrubbed
    batches; a failing or slow sink never blocks the others or the app.
- **PostHog is a module, `wisp.posthog`** (`plugins/posthog/{core,host}`, extends `wisp.telemetry`): it
  contributes a `telemetry.sink` with v1's endpoint, key handling and payload shape. Turning it off, or
  replacing it with another sink (a user plugin, an exec-tier plugin, a file sink for debugging), changes
  nothing else.
- **Events come from the plugin that owns the fact**: a plugin calls `Track` or the telemetry plugin
  subscribes to that plugin's kernel events (`turn.finished` → `turn_ended`). No plugin knows any vendor.
- **Adding an event** = one catalogue entry (name, properties, owner, UI-allowed or not) plus a golden.
  **Adding an analytics tool** = one sink module. The golden of the catalogue (v1's 52 events, names and
  property keys) fails CI if one goes missing.

## Consequences

The opt-out and scrubbing rules apply to every sink by construction. A sink can't receive raw, unscrubbed
events. Sinks are listed in Settings → Plugins like any plugin, with their permission (`net:connect{host}`).
