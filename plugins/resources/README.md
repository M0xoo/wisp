# wisp.resources

wisp as code (ADR-0026, ADR-0028). v1 kept its setup in `config.json`, `crew.json`, `harnesses.json` and a
dozen other files under `~/.wisp`, written by the app; `wisp import` copied them in without showing what it
would change.

## Intent

- Everything a user sets up is a resource: a kind, a stable name and a typed spec. Each plugin owns its kinds
  through `resource.kind@1`: schema from its Rust type and doc comments, `read`, an optional own `plan`, and
  `apply` through its own commands. The kernel knows none.
- A formula (`wisp.yml`, or `.json` / `.toml` with the same shape) declares them:
  - `wisp: 1`, then sections, one document or several;
  - `include:` other formulas (paths, URLs, `gist:<id>`);
  - `profiles:` picked with `--profile`;
  - `${env:NAME}` filled in, `${secret:NAME}` kept as a reference (it must exist here; it never goes in a
    row).
- `wisp apply -f` plans, shows the diff and asks in a terminal (`--yes` in scripts, `--dry-run`, `--prune`).
  A desired spec patches the current one, so a field the formula leaves out keeps its value. `wisp diff -f`,
  `wisp validate -f` (schema and each kind's checks, with paths) and `wisp schema` (for editors) use the same
  engine.
- `wisp export [kinds…]` writes the current state back. It round-trips: export, then apply, is a no-op.
  Personal and device kinds stay out unless `--include`d.
- A formula from elsewhere (a URL or a gist anywhere in its includes) shows its sensitive ops in plain words.
  Apply refuses them without `--trust`, and so does the server.
- Applying or pruning never touches task history (ADR-0029).

## Kinds today

`setting` (wisp.settings), `agent` (runtime), `crew`, `task` (automations; sensitive), `workflow`
(workflows), `router`.

## Not yet

- **Kinds:** `project`, `harness`, `account`, `team`, `skill`, `machine`, `connector`, `tools`,
  `capability`, `channel`, `trigger`, `goal`, `budget`, `pipeline`, `plugin`, `app`/`pane`, `ui`.
  Their plugins don't keep them as rows or commands yet; `pending-kinds.txt` lists the ones with tables.
- **Apply:** it isn't all-or-nothing. A failing op stops it after the ones before it.
- **Other commands:** `wisp run --formula f.yml "task"` (an ephemeral overlay), `wisp grid deploy -f`, and
  `wisp import` as "export v1 as a formula, then apply".
