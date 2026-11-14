# ADR-0030: YAML, TOML and JSON Schema crates for formulas

- Status: accepted
- Date: 2026-11-08
- Source: ADR-0026 ("A YAML parser is a new dependency, recorded in the ADR-0015 list"); the lead: "pick a
  maintained YAML crate, record it in ADR-0015". ADR-0015 is not edited after it merges, so this ADR extends
  its table.

## Decision

Three crates join `[workspace.dependencies]`:

| Crate | Why |
|---|---|
| `serde-saphyr` 2.1 | reads formulas (`wisp.yml`: one document or several) into `serde_json::Value`. `serde_yaml` is archived and unmaintained, and `serde_yml` is a fork with a troubled history. `serde-saphyr` is built on `saphyr`, the maintained YAML 1.2 parser, and was released 2026-11-05 with ~13M recent downloads. MIT OR Apache-2.0 |
| `toml` 1.2 (`parse`, `serde`, `display`) | the TOML form of a formula (`wisp.toml`), read and written. Already in the lock file through other crates. MIT OR Apache-2.0 |
| `schemars` 1.2 | each resource kind's JSON Schema, generated from its Rust spec type and doc comments (ADR-0026: "schema generated from the Rust type with doc comments"). It feeds validation, `wisp schema`, and the forms Settings generates. MIT |

- YAML is **written** by wisp-resources-core itself: a small block-style writer with `name` first, quoting
  only where YAML would read the text as something else. Exports read well in review, and a test parses them
  back with `serde-saphyr`. No YAML emitter crate is needed.
- `serde-saphyr` and `toml` are used only in `wisp-resources-core`, which stays sans-IO; the CLI does the
  file and URL reading. `schemars` is in the `api` crates that own spec types.
- `serde-saphyr` 2.x declares `rust-version = 1.89`, so the workspace's `rust-version` goes from 1.88 to
  1.89. The release toolchain is newer, so nothing else changes.

## Consequences

- `cargo deny` sees three more permissive licences (no new licence kinds).
- A kind's schema changes when its Rust type does: spec types carry `deny_unknown_fields`, so a typo in a
  formula fails `wisp validate` with the field's path.
