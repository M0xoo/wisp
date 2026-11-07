# ADR-0003: Everything is a plugin: kernel, manifests, scopes, interceptors, services

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1's `server/index.js` wired 54 services onto one shared `app` object, so any part could call any other. Spells could restyle wisp but were a second concept with their own API.

## Decision

- A **kernel** (`@wisp/kernel`) with no features: manifests, resolution, plugin groups, scopes, commands, events, interceptors, list extension points, services, settings, capability sets, diagnostics.
- A plugin is `plugins/<name>/{api,host,ui}`. Its static truth is `host/wisp-plugin.json` (`wispPlugin: 1`). Others may depend on its `api` only. A *module* extends exactly one plugin (`wisp.claude` extends `wisp.runtime` through `runtime.harness`).
- Six ways to collaborate (plan §6.11): commands, events (after commit, per-plugin ordered queues), interceptors (ordered, continue/modify/veto, guards fail closed), list points, topics, services (typed, permission-checked proxies, owned by the caller's scope).
- No loops and no deadlocks: every call carries a trace (depth ≤ 8, no re-entering a (plugin, hook) pair), interceptors may not write (follow-ups go in `then`), and hooks have time budgets.
- Two tiers: built-in (in-process) and **exec** (a subprocess speaking JSON-RPC over stdio). WASM, a registry and remote-UI descriptors are cut until someone asks for them (plan §6.6, draft 3).
- The product is a plugin group: `DefaultPlugins`, `BoxPlugins`, `HeadlessPlugins`, `MinimalPlugins`, in `apps/server`. That is the only place features are named.
- **Spells are plugins** (plan §6.0). A `wispSpell` file is converted to a manifest on import and still loads for two releases. Built-ins get no private API.

## Consequences

Switching any part off is dropping its scope, so there is no cleanup to write by hand. The kernel's contract (`packages/kernel/src/contract.ts`) is now public API: changing it needs `monoflow graph impact` and a note in the PR.
