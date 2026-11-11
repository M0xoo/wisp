# ADR-0048: Anything downloaded is an untrusted plugin; its UI is described, not run, in the app

- Status: accepted
- Date: 2026-11-11
- Source: the queue's "untrusted plugin tier" (plan §6.0.2; owner, 2026-11-11: "ADR first"); extends ADR-0046
  (plugins installed at runtime), with ADR-0003 (everything is a plugin), ADR-0028 (trust), ADR-0036 (apps and panes
  are untrusted UI in a sandboxed frame).

## Context

ADR-0046 installs a user's plugin from a folder or a git URL, off until switched on, with what it asks for shown
first. Switched on, its server code runs as an `exec` child with the permissions its manifest lists, and the
manifest's `trust` field (`trusted`, `untrusted`, `declarative`) is read but changes nothing. A plugin's UI can't run
at all: the app only loads the UI plugins bundled with it. So a downloaded plugin is either harmless and useless or,
once it gets UI, as powerful as wisp's own code in the user's session.

## Decision

1. **Three tiers.** Built-in (compiled in), **trusted** (a plugin you wrote or chose to trust: its own process, its
   permissions) and **untrusted**: the default for anything installed from a folder, a URL or a share. An installed
   plugin is untrusted whatever its manifest says; only the user makes it trusted (Settings → Plugins → Trust, which
   says what that lets it do). Built-in ids stay reserved (ADR-0046).
2. **Untrusted server code** stays a JSON-RPC subprocess, with its environment emptied but for what its permissions
   name, its folder as its home and working directory, and every call checked against its own capability set. Its
   next home is the WASM component host (wasmtime, WASI 0.3, behind the `wasm` feature): no ambient file system,
   network or processes at all. That host is a new dependency and gets its own ADR when it's built.
3. **Untrusted UI is described, not run, in the app.** Its UI module runs in a Worker inside a sandboxed frame
   (`sandbox="allow-scripts"`: an opaque origin, so no cookies, no storage of wisp's and no wisp API by its own
   requests), and has no DOM. It sends **descriptors**: a tree of kit components by name (`Stack`, `Inline`, `Text`,
   `Button`, `Input`, `Switch`, `Select`, `SettingsRow`, `ListRow`, `Callout`, `Code`, `Markdown`) with their typed
   props (text only: no HTML, no `class`, no `style`). The app renders them with the kit, so an untrusted plugin looks
   like wisp and can't draw anything else. Events (a click, an input's value) go back as messages.
4. **Its API is the plugin API, by RPC, as itself.** `wisp.call(cmd, args)` and `wisp.watch(topic)` go over the
   frame's message channel to the app, which sends them as the plugin (`x-wisp-plugin: <id>`, honoured only for an
   untrusted UI's calls and only by the app's own connection): the kernel checks them against the plugin's capability
   set, never the user's.
5. **Where it may show:** a Settings pane, a side view, a block renderer and a toolbar button. Not the frame, the
   list, the composer or another plugin's view.

## Consequences

- `plugins.install` writes `trust: "untrusted"` on what it installs; `plugins.trust {id, trusted}` changes it.
- The shell gains a remote-view host (the frame, the bridge, the descriptor renderer); the kit gains nothing: the
  renderer maps names to existing components.
- A trusted plugin's UI may still be a bundled module later (built-ins are), but that's not this ADR.

## Edge cases

Each one is a test named after it.
- `an_installed_plugin_is_untrusted_whatever_its_manifest_says`
- `an_untrusted_plugins_calls_are_checked_against_its_own_permissions`
- `a_descriptor_names_only_kit_components_and_their_props_and_anything_else_is_dropped`
- `an_untrusted_ui_cannot_reach_wisps_api_or_storage_from_its_frame`
- `an_event_goes_back_to_the_plugin_by_the_id_its_descriptor_gave`
