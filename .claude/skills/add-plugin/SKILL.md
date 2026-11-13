---
name: add-plugin
description: Use when adding a new feature area to wisp v2 or moving one into its own plugin: scaffolds plugins/<name>/{api,host,ui}, writes the manifest, registers it in a plugin group, and verifies it with monoflow.
---

# Add a plugin

1. Is this a new **plugin** (owns a domain: tables, commands, topics) or a **module** (extends exactly one
   plugin through its extension point, e.g. a harness for `wisp.runtime`, a transport for `wisp.channels`)?
   Modules set `"kind": "module", "extends": "<plugin>"`.
2. `node tools/new-plugin.ts <name>` scaffolds `plugins/<name>/api`, `host` (with `wisp-plugin.json`) and `ui`.
3. **Write `api/` first.** Commands (id, args, result types), events, topics, row types, extension points
   (each with a version), and services (`defineService` with a permission for every method). Other plugins
   may import only this package. Before changing an existing `api`, run
   `.agents/bin/monoflow graph impact plugins/<name>/api/src/index.ts`.
4. **Manifest** (`host/wisp-plugin.json`): permissions for every kernel service and other plugins' commands
   you call, `activation` events (avoid `onStartup`; justify it in review), settings with types, and
   contributions. `npm run check` validates it.
5. **Host:** `export default definePlugin({ id, setup(ctx) { … } })`. Register everything through `ctx`, so
   it belongs to the plugin's scope. Write through `store.tx`. Never import another plugin's `host`.
6. **UI:** extensions attach to shell inputs (`shell.task:head`, `shell.composer:left`, …), built from
   `@wisp/ui` only. No CSS. Strings go through `t()`. `ui/src/index.ts` registers the UI with a default
   export, `export default definePluginUi({ id, catalogue, views, extensions, … })` from `@wisp/shell`
   (as `plugins/stuff/ui/src/index.ts` does); the scaffold writes one. Without it `npm run check` fails
   with "… is registered nowhere".
7. Add it to the plugin groups in `apps/server/src/groups.ts` that should ship it.
8. Tests: `host/test/` with `@wisp/testkit` (the free tests: "deactivate leaks nothing" and "a missing
   permission is refused"), plus the plugin's own behaviour. Then `.agents/bin/monoflow verify --affected`.
9. Add a CHANGELOG entry if users see it, and an ADR if it adds a new kind of thing (`record-decision`).
