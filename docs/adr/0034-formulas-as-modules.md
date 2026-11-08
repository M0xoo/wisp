# ADR-0034: Formulas are a folder of files with references, variables and modules (like Terraform)

- Status: accepted. Supersedes ADR-0026's "one file" format; its plan/apply/export model stays.
- Date: 2026-11-09
- Source: the owner: "I don't like declare in one file; handle references etc. like Terraform does."

## Decision

- **A formula is a folder, not a file.** wisp loads every `*.wisp.yml` (and `.json`/`.toml`) in it as one
  configuration, the way Terraform loads every `.tf` in a directory. File names and splits are the user's
  choice: `agents.wisp.yml`, `crew.wisp.yml`, `workflows/release.wisp.yml`. In a repo the folder is `.wisp/`.
- **Resources are addressed and referenced.** Every resource has an address `<kind>.<name>` (`agent.reviewer`,
  `crew.ada`, `machine.studio`, `connector.linear`). Any field may reference another resource or its attributes
  with `${agent.reviewer}`, `${machine.studio.address}` or `${workflow.release.tasks.tests.output}`.
  - References build the dependency graph, so apply creates things in order and refuses cycles.
  - A rename (`wisp mv agent.reviewer agent.critic`) rewrites the references.
  - `wisp graph` prints the graph.
- **Variables, locals and outputs:**
  - `variable "model" { type: string, default: opus }` in YAML form, set with `-var model=sonnet`,
    `--var-file prod.yml`, `WISP_VAR_model`, or prompted for in a TTY;
  - `locals` for derived values;
  - `output` for values other formulas, the CLI (`wisp output`) and the SDK read.
  - Types are checked at plan time.
- **Modules: reusable formula folders with inputs and outputs.**
  `module "reviewers" { source: github.com/acme/wisp-modules//review-team?ref=v1.2, inputs: { model: … } }`.
  Sources can be a local path, a git URL with a ref, or a registry name later. `wisp init` fetches them into
  `.wisp/modules/` and pins them in `.wisp/lock.yml` (hashes), and `wisp init -upgrade` updates them. A
  module's resources are addressed `module.reviewers.agent.reviewer`. This is how teams share a "review team"
  or a "nightly maintenance" setup across repos.
- **Expressions:** a small, safe expression language: references, string interpolation, `count`/`for_each`
  over lists and maps (one crew member per service), conditionals, a short list of pure functions (`lower`,
  `join`, `file`, `env`, `secret`). There is no general code execution.
- **State is wisp's store** (ADR-0004), not a state file. `plan` diffs the declared configuration against what the
  store holds, so drift (changes made in the app) shows in `wisp plan`, and `--refresh-only` adopts it into the
  files' view (`wisp export` writes the files back).
- **Workspaces** replace profiles: `wisp workspace select prod` keeps separate variable sets (and, on the grid,
  separate boxes) for the same formula.
- **Commands** keep ADR-0026's names, with Terraform's where they fit:
  - `wisp init`, `wisp plan`, `wisp apply`, `wisp destroy`;
  - `wisp output`, `wisp graph`, `wisp validate`, `wisp fmt`, `wisp mv`;
  - `wisp import <address> <id>`, which adopts something created in the app into the files.
- **Tasks and workflows** reference the same addresses (`agent: ${agent.reviewer}`), and a task's formula
  snapshot (ADR-0029) records the resolved values and the module versions it ran with.

## Consequences

- The resources plugin gets a loader (folder, merge, duplicate-address errors with both file:line), an
  expression evaluator (pure, in `core`, property-tested), a module fetcher (git through `wisp-proc`, cached by
  hash), and a lock file.
- `wisp export` writes a folder split by kind (one file per kind by default, `--single-file` on request).
- The site says "declared in your repo", not "one file".
