# wisp-kernel

The plugin host (ADR-0003, ADR-0013, plan §6). It knows no feature: plugins register commands,
interceptors, subscribers, list-point contributions, services and HTTP routes in `setup`, and all of it
belongs to the plugin's scope. Switching a plugin off cancels the scope and removes every registration.

## Map

| File | What |
|---|---|
| `lib.rs`, `host.rs` | the frozen contract: `Command`, `Event`, `Hook`, `Verdict`, `Point`, `Service`, `Plugin`, `PluginGroup`, `Call`, `Setup`, `Ctx`, `App`, `Kernel` |
| `kernel_api.rs` | additive API: `Kernel::{idle, root_call, commit_hook, wake, choose_provider, define_set, explain, declared, settings, set_setting, failures, refusals, lagging, registrations, ctx, routes, serve}`, `Ctx::{setting, watch_setting, may}`, `Setup::on_raw`, `Declarative`, `CommitHook` |
| `manifest.rs`, `manifest_check.rs`, `manifest_contrib.rs` | `wisp-plugin.json` (plan §6.2): every problem with its JSON path, unknown keys with "did you mean", v1 spell keys named |
| `spell.rs` | `convert_spell`: a v1 `wispSpell: 1` file as a declarative plugin (plan §6.0.1) |
| `semver.rs`, `perm.rs`, `caps.rs`, `capabilities.json` | ranges; `ns:action{k:v}` permissions; capability sets as data (`user:full`, `agent:session[:mode]`, `agent:capped[:mode]` = v1 capped.js in v1's words, `crew:<n>`, `box`, `apikey`, `preview`, `pane:<id>`, `grid:inbox`, `grid:route`, `plugin:<id>` from manifests) |
| `resolve.rs`, `life.rs`, `activate.rs`, `activation.rs` | resolution (topological, services by contract, cycles printed, exact reasons), reconcile, lazy activation (`onStartup`, `onCommand`, `onTopic`, `onRoute`, `onView`, `onBlock`, `onSchedule`), scopes |
| `dispatch.rs`, `hooks.rs`, `call.rs` | the command bus and interceptor chain: depth < 8, no re-entering a (plugin, hook), read-only interceptors, priority + timeouts (200 ms default, 2 s max), fail closed/open, veto `then` |
| `events.rs` | per-subscriber ordered queues, at least once (3 tries), 10k cap then `lagging` |
| `settings.rs`, `diag.rs`, `routes.rs` | settings registry (locks, device/server, watchers), diagnostics rings, route matching + `onRoute` |
| `exec/` | the exec tier: a plugin as a child speaking JSON-RPC 2.0 over stdio (method list in `exec/mod.rs`) |

## Rules the kernel enforces

- **Default deny.** A command's permission is its id with the first `.` as `:` (`runtime.start` →
  `runtime:start`) unless `Command::PERMISSION` names one. It is checked against the caller's set and
  against the calling plugin's own set (its manifest's `permissions` plus its own namespace). A call made
  as `plugin:<id>` is checked on its own hop; past it, the plugin whose code runs acts on its own grant.
  Users, agents, panes and the rest narrow all the way down. Scoped checks inside a command or a service
  method: `call.require("runtime:start{mode:auto}")`; writes in a service: `call.require_write(..)`.
- **Namespaces.** A plugin registers commands under its prefix only (`wisp.git` → `git.*`); a provided
  service must be declared in `provides` with the same major.
- **Commands may recurse** (depth bounds them); **hooks may not be re-entered** by the same plugin.
- **A veto's `then`** runs after the root settles, as a new root call speaking for the vetoer, owned by
  the kernel (it still runs if the vetoer is switched off meanwhile). `kernel.vetoed` is published at once.

## For wisp-store: publishing on commit

Events a command emits are buffered on its root call. Without the store's help they go out when the
root command returns `Ok`, and are dropped when it fails. A command that runs store transactions should
publish at COMMIT instead, so a fact goes out exactly when it is durable:

```rust
let hook = ctx.service::<wisp_kernel::CommitHook>()?;   // every App provides it
let mark = hook.mark(&call);                             // before BEGIN
// … write, ctx.emit(&call, &e) …
hook.committed(&call, Some(change_seq));                 // after COMMIT: buffered events go out now,
                                                         // each envelope carries `cursor: change_seq`
hook.rolled_back(&call, mark);                           // after ROLLBACK: events since mark are dropped
```

Subscribers get an `EventEnvelope { seq, ty, plugin, at, root, cursor, data }`; `seq` is the kernel's
publish order (dedupe), `cursor` the store's change seq when known (a lagging subscriber catches up from
the change feed by it: `Kernel::lagging(plugin)` → `caught_up(plugin)`).

## Exec tier

`ExecPlugin::new(manifest, Some(root))` for a manifest with `"server": {"exec": ["bin", …args]}`. The
child gets `initialize {id, manifest, settings}` and answers once its registrations were accepted.
A death after that is a crash: the plugin is off with the reason (`acme.x's process exited (code 3);
restarting in 1000 ms`) and switched back on with a doubling backoff, up to `max_restarts`. A death or a
timeout during `initialize` refuses the plugin. Installs swap the spawner with an `Arc<dyn ExecSpawner>`
kernel service (the grid sandboxes it). Services don't cross the process boundary yet (no codegen):
exec plugins reach other plugins through commands, hooks and events.

## Tests and benches

`cargo test -p wisp-kernel`; the bench:
`cargo test --release -p wisp-kernel --test kernel_bench -- --ignored --nocapture`.
