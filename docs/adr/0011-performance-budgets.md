# ADR-0011: Performance budgets are enforced like tests

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9 (§2, §8, §9.1); the owner: "performance is a priority, we are creating the fastest dev tool possible"

## Context

The measurements behind v2 are all about speed: 41 ms instead of 881 ms per streamed session write,
0.65 ms instead of 5.7 ms to load a session's tail, Solid at a sixth of React's scripting while streaming.
A budget that isn't checked erodes with every feature.

## Decision

- The budgets of plan §8 (in `AGENTS.md` → Performance) are measured by `tools/budgets.ts` and by the gate
  benches in `spikes/` (G1 store, G3 sync fan-out, UI streaming). CI fails on a miss.
- A hot-path change brings its bench numbers, before and after, in the PR.
- `tools/check` refuses synchronous I/O (`*Sync`) in plugin host code outside startup and migrations.
- A budget only changes through a new ADR, with the measurement that justifies it.

## Consequences

Some code is more careful than it would otherwise be: coalesced writes, prepared statements, lazy
activation, virtualised lists. CI needs a few seconds more for the benches. Budgets are measured on CI
hardware with headroom, and on the real devices (M2, Pixel) before a release.
