# wisp v2 architecture

This page is the map. The reasons are in `docs/adr/` (one decision per file). The plan they came from is
the *wisp v2 rewrite plan* (draft 9). When code and this page disagree, fix whichever one is wrong in the
same PR.

## One sentence

A small **kernel** hosts **plugins**. Each plugin owns one domain: its tables, commands, events, topics,
settings and extension points. The product is a **plugin group**. A **store** (SQLite) records every write
in a **change feed**. The **sync** layer turns that feed into topics that every client and every peer
subscribes to by cursor. The UI is a Solid app built only from the **kit** (`@wisp/ui`), and it reads all
its data from one **client store**.

```
apps/web (Solid)  ─┐                                   ┌─ peers: other computers, grid boxes
apps/desktop      ─┼─ @wisp/client ── SSE + POST ──────┤   (transports: ssh, grid, grid-tunnel)
mobile (Capacitor)─┘   entity store · nav · machines   │
                                                       ▼
apps/server (wisp-agents) ── @wisp/kernel ── plugins/*/host ── @wisp/store (node:sqlite) ── @wisp/sync
                                │
                                └── @wisp/native (Rust: PTY + process trees, Python fallback)
```

## Layout

```
packages/            the base, no features
  kernel/            plugin host: manifests, resolution, scopes, commands, events, interceptors,
                     services, capability sets, plugin groups (ADR-0003, ADR-0008)
  store/             node:sqlite: migrations per plugin, event log, change feed, mutations, blobs,
                     the v1 importer (ADR-0004)
  sync/              sans-IO: topics, cursors, per-connection outbox, JSON Patch (ADR-0005)
  protocol/          the wire types every side shares (ADR-0005)
  client/            the client's six kinds of state: entities, derived, navigation, machines,
                     drafts, preferences; peers and transports (ADR-0006)
  tokens/            design tokens (JSON → CSS variables + TS unions)
  ui/                the kit: Solid components on Zag. The only package with CSS (ADR-0007)
  testkit/           fake clock, fake harness, fake gh, plugin harness, goldens
  native/            the Node side of wisp-native, with the fallback (ADR-0010)
plugins/<name>/      one folder per plugin (vertical slice)
  api/               @wisp-plugin/<name>-api: what others may depend on (commands, events, points,
                     services, row types). Other plugins import only this.
  host/              @wisp-plugin/<name>: server side. wisp-plugin.json lives here.
  ui/                @wisp-plugin/<name>-ui: UI extensions, kit components only
apps/
  server/            wisp-agents, the published package: bin, HTTP edge, plugin groups
  web/               the one web bundle: shell, router, extension tree host
  desktop/           Tauri shell (Rust), ships the same bundle
mobile/              Android: Capacitor + sshj, ships the same bundle
grid/                wisp Grid: edge, hostd, boxd, its own SQLite
native/              Cargo workspace: wisp-native
tools/               check (structure rules), test runner, bundle, dev, codegen
docs/  design/  qa/  spikes/
```

## The rules that keep it this shape

They are checked by `npm run check` (`tools/check/`), in CI from the first commit:

1. **Layers.** `packages/*` ← `plugins/*/api` ← `plugins/*/host`, `plugins/*/ui` ← `apps/*`. A layer
   imports only from layers below it. Plugins import other plugins' `api` only, never `host` or `ui`.
2. **Public entry.** Cross-package imports go through the package name (`@wisp/kernel`), never a path
   into another package's `src/`.
3. **No cycles**, between packages or between files.
4. **CSS lives in `packages/ui` only.** No `class=`, no `style=` except CSS custom properties, no `.css`
   import, outside the kit.
5. **State has one home** (ADR-0006): no module-level `let` in UI packages, no `fetch` outside
   `@wisp/client`, no `history`/`location` outside navigation, no `setTimeout` outside a scope.
6. **Every manifest validates**, every command is named by a capability set, every extension point has a
   version, every service method maps to a permission.
7. **Every route is in OpenAPI** and every protocol change is diffed against released snapshots.
8. **Sizes.** Files over 400 lines and functions over 60 warn; the check prints them.

## How a feature is built

1. Pick its owner plugin, or make one (`node tools/new-plugin.ts <name>`).
2. Write the contract in `api/` first: commands, events, topics, points, row types.
3. Implement `host/` against the kernel and other plugins' `api` only. Writes go through commands;
   commands write through the store in one transaction; the change feed tells everyone.
4. Implement `ui/` from kit components, registering extensions into the shell's inputs. Read through
   the client store, write through commands with a declared optimistic patch.
5. Tests next to it (`host/test/`, `ui/test/`). Goldens for anything an agent or a peer reads.

See `AGENTS.md` for the working rules and `.claude/skills/` for step-by-step how-tos.
