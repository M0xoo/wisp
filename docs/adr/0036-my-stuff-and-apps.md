# ADR-0036: My Stuff is data; apps and panes are plugins you can keep as code

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "how do apps and My Stuff fit in v2?"
- With ADR-0003 (plugins; plan §6.0 merged panes into plugins), ADR-0020 (per-app SQLite), ADR-0028 (code first),
  ADR-0033 (repo history).

## Decision

**My Stuff holds what agents and you make that isn't code in a repo:** docs, plans, images, videos, links,
generated files, and apps. Each item is a row in the store (owned by `wisp.stuff`) with its content in the blob
store (content-addressed, deduplicated). Items are **data**, like tasks: tagged, searchable and versioned (each save
is a version, like v1's "v9"), linked to the task that made them, and visible on every computer through sync.
`@` mentions bring them into prompts (ADR mentions, v1's intent).

**Apps and panes are plugins:**
- An **app** (a small web app an agent built: a dashboard, a form, a game) and a **pane** (a view shown beside a
  task) are both UI plugins of the untrusted tier (plan §6.0.2): HTML/JS run in a sandboxed frame with the kit's
  tokens as CSS variables, talking to wisp through the plugin API over RPC (v1's pane-bridge, kept as the API),
  with only the permissions they declared and the user allowed (`pane:<id>` capability set).
- Their data, when they ask for it, is their own SQLite (ADR-0020), reset or removed with them.
- So "make me an app" and "make me a plugin" are the same request at different trust levels. An app can be
  promoted to a trusted plugin, and a plugin can ship a pane.

**As code (ADR-0028):**
- `app` and `pane` are resource kinds. Their source is a folder (`source: ./apps/standup-board`) or a My Stuff
  item, plus permissions, data schema and whether they're published. That means an app can live in the repo
  (`.wisp/apps/<name>/`), be declared in a formula, shared as a module, and reviewed in a PR.
- Docs and other items aren't configuration. They export with `wisp stuff export` and can be referenced from a
  formula by id (a crew member's brief pointing at a doc).
- When the project tracks history (ADR-0033), the items a tracked task produced are saved with it in `.wisp/`.

**Everywhere (ADR-0024):**

| Where | My Stuff | Apps |
|---|---|---|
| App | the My Stuff page and side pane | launch inside wisp, pin beside a task |
| TUI | a list with preview (text, markdown, images where the terminal shows them) | `o` opens in the browser; text-only panes render natively |
| CLI | `wisp stuff ls/save/show/open/export` | `wisp app new/run/publish/logs` |
| SDK | `w.stuff` | `w.apps` |
| Agents | `wisp_save` / `wisp_stuff` MCP tools (v1's) | build one with the *Make a plugin* agent |

**Publish:** `wisp app publish` (or Publish in the app) puts an app on your wisp Grid at a public link, with its own
database, as in v1.

## Consequences

- `wisp.stuff` owns items and the shelf. Apps and panes are run by the plugin host's untrusted tier, so there's
  one sandbox, one permission model and one bridge for apps, panes and third-party plugins.
- Starters (the panes wisp ships with) are built-in plugins of the same kind.
