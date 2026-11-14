# ADR-0046: A user's plugin is installed while wisp runs, from a folder or a git URL, off until you switch it on

- Status: accepted
- Date: 2026-11-11
- Source: the queue's backend leftover ("the plugins install path: an ADR first: a plugin source at runtime,
  through the kernel's exec host, per ADR-0003/0031"); ADR-0003 (everything is a plugin; built-ins get no private
  API), ADR-0031 (no v1 compat: v1's spells and plugin folders are not read), ADR-0028 (trust and permissions),
  ADR-0042 (a user plugin can fill any point a built-in fills).

## Context

`wisp plugin new <name>` scaffolds `~/.wisp/plugins/<name>/wisp-plugin.json`, the kernel has an exec tier
(`ExecPlugin`: a child speaking JSON-RPC over stdio, its registrations checked under its own capability set) and a
declarative one (`Declarative`: a manifest only), and `plugins.setEnabled` switches a plugin on and off at runtime.
But nothing loads a user's plugin: `wisp serve` builds its kernel from the compiled plugin group only, the kernel
can't add a plugin after it starts, and there is no way to get a plugin from somewhere else.

## Decision

1. **Where a user's plugins live:** `~/.wisp/plugins/<slug>/`, one folder each, its `wisp-plugin.json` at the top.
   Its id starts with `user.` (built-in ids are reserved: an install that claims one is refused, so a plugin can
   never pass for a built-in and get its trust).
2. **At start**, `wisp serve` reads every folder there and adds each plugin to the kernel with the built-ins: an
   `exec` server becomes an `ExecPlugin` rooted at its folder, anything else a `Declarative`. Each starts **off**
   unless its `plugin` resource says it's on (the plugins plugin's kind already applies `enabled` at start).
3. **While wisp runs**, the kernel can add and remove a plugin: `Ctx::install_plugin(plugin)` adds a slot (off) and
   reconciles; `Ctx::uninstall_plugin(id)` switches it off, waits for it to stop, and drops the slot. Both need
   `plugins:manage`, and only `user.` plugins can be removed.
4. **`plugins.install {source}`** (CLI `wisp plugin install <source>`, the app's Plugins pane): `source` is a folder
   on this computer or a git URL. A folder is copied, a URL is cloned (`git clone --depth 1`, through the proc
   service, never a shell). The manifest is validated (`Manifest::validate`) before anything is added; the folder
   goes to `~/.wisp/plugins/<slug>` (an existing one of the same id is replaced only after the new one validates).
   The answer names the plugin and **the permissions it asks for**: switching it on (`plugins.setEnabled`) is the
   consent, so nothing it asks for runs before you say yes.
5. **`plugins.uninstall {id}`** takes a `user.` plugin off and deletes its folder.

What it doesn't do: no registry or marketplace (a source is a folder or a git URL); no v1 spell or plugin folder is
read (ADR-0031); no automatic updates (installing again from the same source is the update).

## Consequences

- The kernel gains `install_plugin` / `uninstall_plugin` on `Ctx` (additive); `life` gains the add and remove paths
  next to `set_enabled`.
- A user's exec plugin runs as a child of `wisp serve` on this computer, with only the permissions its manifest
  lists and you switched on; on a wisp Grid box the exec spawner sandboxes it as before.
- The Plugins pane lists `user.` plugins with their source, Install… and Remove.

## Edge cases

Each one is a test named after it.
- `an_installed_plugin_starts_off_until_switched_on`: after `install_plugin`, the plugin's status is off with "not
  switched on yet"; `set_enabled(true)` starts it.
- `a_plugin_claiming_a_built_in_id_is_refused`: a manifest whose id doesn't start with `user.` is refused before
  anything is copied.
- `an_invalid_manifest_is_refused_and_nothing_is_kept`: a bad manifest leaves no folder and no slot behind.
- `installing_the_same_id_again_replaces_it`: the old plugin goes off and its folder is replaced, once the new
  manifest validated.
- `uninstall_takes_a_user_plugin_off_and_removes_it`: its registrations go with it, the slot and folder are gone;
  a built-in can't be uninstalled.
- `user_plugins_load_at_start`: a folder under `~/.wisp/plugins` is in the kernel after `wisp serve` starts, off.
