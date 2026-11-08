# ADR-0026: wisp as code: everything a user sets up is a declared resource

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "a yml file declaring agents, crew members, machines, tools, MCP… imported into wisp,
  run with the CLI (`--formula`), or deployed to the grid; and this should be how wisp works internally."

## Decision

- **Resources.** Everything a user configures is a *resource* with a kind, a stable name and a typed spec:
  `project`, `crew` (members, their kit, schedule, team), `machine` (peers and their transport),
  `connector` (MCP servers), `account` (harness accounts: references only), `recipe`, `trigger` / `automation`,
  `channel`, `plugin` (on/off, config, user plugins), `setting`, `goal`, `budget`, `router` (Auto's settings).
  Tasks and their history are *not* resources; they're what resources produce.
- **Each plugin owns its kinds** through one point, `resource.kind@1`, contributed in its `api`/`host`:
  - `schema` (JSON Schema, generated from the Rust type with doc comments);
  - `read()` (current state, as specs);
  - `plan(current, desired)` (pure, in `core`: the creates, updates and deletes);
  - `apply(op)` (through the plugin's own commands, so permissions, events and the change feed work as usual).
  The kernel knows no kind; a user plugin can add its own.
- **Internally it's the same thing.** The GUI, TUI and CLI edit resources through those same commands, and the
  store holds the current state. So `wisp export` always round-trips: export, then apply, is a no-op. Clicking in
  Settings and editing the file are two views of one state.
- **The file: a formula.** `wisp.yml` (YAML, plus JSON and TOML with the same schema), versioned
  (`wisp: 1`), one document or several, with `${secret:NAME}` and `${env:NAME}` references. Secrets never go
  in the file; they stay in `secrets.json` (ADR-0004). It can `include:` other formulas, and `profiles:` select
  parts (`--profile work`).
- **Commands** (ADR-0022 CLI):
  - `wisp apply -f wisp.yml`: plan, show the diff, confirm in a TTY (`--yes` in scripts), apply. `--dry-run`
    only plans. `--prune` also deletes what the file doesn't declare (off by default).
  - `wisp export [kinds…] > wisp.yml`: the current state as a formula, secrets as references.
  - `wisp diff -f wisp.yml`: what apply would change.
  - `wisp run --formula f.yml "task"`: a task in an ephemeral overlay (its crew, connectors, settings exist
    for that task only and leave nothing behind).
  - `wisp grid deploy -f wisp.yml [--box name]`: apply to a cloud box over the peer protocol. Same plan and
    diff; the box's own capability set applies.
  - `wisp import` (v1's `~/.wisp`) becomes "export v1 as a formula, then apply", so it shows its plan first.
- **Validation everywhere:** `wisp validate -f wisp.yml` (schema plus each kind's checks), an editor schema
  (`wisp schema > wisp.schema.json` for YAML language servers), and the same schema in Settings → Import.
- **Drift:** `wisp diff` against the file shows what changed in the app since the last apply. Settings marks
  values a formula set, and saving one in the app asks whether to update the file too (when it knows the file).

## Consequences

- One generic engine (`plan`/`apply`/`export`) in a `wisp.resources` plugin, plus a `resource.kind` per owner.
- Crew sharing (`.crew.json`), plugin manifests and v1 spells become special cases of formulas.
- A YAML parser is a new dependency (recorded in the ADR-0015 list). Plans are pure and golden-tested per kind.
