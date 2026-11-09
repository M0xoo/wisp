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

## Sharing a setup made in the app (added 2026-11-09)

Nothing has to be written by hand to share. Everything made in the app (crew members, agents, workflows,
connectors, rules) is already a resource, so:
- **App and TUI: Share setup** (Settings, or the menu of a crew member, agent or workflow). Pick what to include
  (everything, or just "Ada and her team"); the preview shows the files it writes, with secrets as `${secret:…}`
  and personal kinds (accounts, UI) left out. Then send it as a folder or zip, a link on the grid, a gist, or a
  module in a git repo, so other projects can use it by `source:`.
- **CLI:** `wisp export crew.ada --with-deps > ada/` writes Ada with what she references (her agent profile, team,
  skills, connectors). `wisp export --all` writes the whole setup.
- **Receiving:** Import setup (or `wisp apply`, or adding it as a module) shows the plan in plain words, asks for any
  secret the receiver doesn't have yet, and refuses new permissions without confirmation (ADR-0028 trust).
- v1's crew sharing (`.crew.json`, gists) becomes this; the old files are read once by `wisp import`.

### Importing in the app and the TUI (added 2026-11-09)

Import is a first-class screen, not a CLI-only step:
- **Ways in:** drag and drop a folder, zip, `.wisp-task` or `wisp.yml` onto the window; open a grid share link or
  a `wisp://` link (the app registers the scheme); paste a gist, git or module URL into **Import** (Settings, the
  palette, the project menu); or, on first run, **Bring your setup from wisp v1** (`wisp import`).
- **The plan, visually:** one card per resource, grouped as added, changed and removed, each with what it does in
  plain words ("Ada reviews every PR on weekdays at 7 with Codex"). Changes show a field-level diff. A **Trust**
  section lists new permissions, connectors, channels, triggers and machines, each needing a tick.
- **Secrets inline:** a missing `${secret:linear}` shows as a field to fill right there. It's saved to
  `secrets.json`, never to the files.
- **Pick what to take:** untick any resource (its dependents are unticked with it, and the plan says why).
- **Apply** shows progress per resource at once, and rolls everything back with a clear message if one fails
  (atomic apply). Imported tasks (`.wisp-task`) open on their run, rerun, import-read-only and compare choices
  (ADR-0027).
- The TUI has the same screen (`wisp tui`, Import, or `i`). The CLI shows the same plan as text.
