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

| Owner | Kinds |
|---|---|
| wisp.settings | `setting`, `ui` (device) |
| wisp.runtime | `agent`, `project`, `harness`, `skill`, `team` |
| wisp.accounts | `account` (personal) |
| wisp.crew | `crew` |
| wisp.machine | `machine` (sensitive) |
| wisp.connectors | `connector` |
| wisp.mcp | `tools` |
| wisp.resources | `capability` (sensitive) |
| wisp.channels | `channel` (sensitive), `notification` |
| wisp.automations | `task` (alias `recipes:`, sensitive), `trigger` (sensitive) |
| wisp.goal | `goal` |
| wisp.budget | `budget` (stop lines applied) |
| wisp.router | `router`, `pipeline` |
| wisp.plugins | `plugin` (sensitive) |
| wisp.stuff | `app`, `pane` |
| wisp.workflows | `workflow` |

`account`, `crew`, `setting`, `agent`, `task`, `workflow`, `router` and budget's stop lines act on real
state through their owners' commands. The others are kept as declared (`StoredKind`, in the owner's own
`<plugin>_spec_<kind>` table) until their owner is ported and reads them. They are exported, diffed and
applied like the rest.

**Apply is all or nothing:** if an op fails, the ops already applied are undone, last first, through the
same owners. The error then says "nothing was changed", or names what couldn't be undone.

## Not yet

- **Kinds:** `grid` and `box` (wisp Grid's client isn't in this build). The owners above that keep
  declared specs still have to act on them: worktree policy, setup scripts, harness pins, connectors,
  channels, triggers, machines, capabilities, plugins.
- **Commands:** `wisp run --formula f.yml "task"` (an ephemeral overlay) and `wisp grid deploy -f`.
