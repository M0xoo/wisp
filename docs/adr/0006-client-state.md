# ADR-0006: Client state: six kinds, each with one home

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

In the last 60 days, most UI fixes came from state with two owners, state that outlived its owner, or a late answer landing on the wrong thing (plan §4.6.1). In v1, `S` was imported by 92 of 157 modules.

## Decision

- `@wisp/client`, framework-independent TypeScript on `alien-signals`:
  1. **entities**: server data, normalised and keyed by origin id, written only by sync and commands' optimistic patches;
  2. **derived**: computed selectors, never stored;
  3. **navigation**: one `Nav` value, one writer (`navigate(intent)`, a pure reducer), mirrored in the URL;
  4. **flows**: state machines owned by a scope;
  5. **drafts**: keyed by (entity, field), persisted per peer;
  6. **preferences**: typed settings from manifests, `lockedBy`.
- Everything else is a local signal that dies with its component. There is no global object, no module-level mutable state, and no event bus that carries state.
- Every request belongs to a scope and carries its `AbortSignal`. Commands need `optimistic` or `optimistic: 'none'`.
- `tools/check` enforces it: no module-level `let` in UI packages, no `fetch` outside `@wisp/client`, no `history`/`location` outside navigation, no bare timers.

## Consequences

The view layer can change without touching the data layer. Tests of the state layer need no DOM.
