# ADR-0031: No compatibility with v1's interfaces

- Status: accepted. Supersedes the compatibility parts of ADR-0003 (wispSpell loading), ADR-0004 (dual-write of
  v1 JSON files), ADR-0005 (v1 event names, the proto window reaching v1), ADR-0010 (the v1 whole-stream relay),
  ADR-0027 (v1 share links) and the team brief's "v1's HTTP API stays as thin adapters".
- Date: 2026-11-08
- Source: the owner: "you should not care about v1 backward compatibility."

## Decision

v2 is a new product on a new architecture. It does **not** keep:
- v1's HTTP routes and their JSON shapes (the SDK, the CLI and the frontends use v2's commands, topics and
  `/api/cmd` only; v1 route adapters are removed, and so are the tests that only checked v1 shapes);
- v1's event-stream names on `/api/events`, or talking to a v1 peer (machines speak v2 only; the v1 relay goes);
- `wispSpell` files and `/api/spells*` (spells are gone, plugins replace them; no converter, no deprecation period);
- writing v1's JSON files alongside the store (no dual-write, no downgrade path);
- v1's grid share links, v1 phone app builds, and the v1 SDK's shapes.

It **does** keep (they are not compatibility):
- **v1's look and behaviour as the spec** for screens and features (ADR-0016, docs/v2-port-intent.md): users get the
  wisp they know, rebuilt;
- **a one-time importer** (`wisp import`, ADR-0026): it reads an existing `~/.wisp` once and turns it into a
  formula plus history, so nobody loses their tasks, crew or settings. It's a migration tool, not a runtime
  layer, and can be dropped later on its own;
- the npm package name and the `wisp` command.

## Consequences

Less code, fewer tests and fewer edge cases. Many plugin hosts lose their `routes.rs` v1 adapters. OpenAPI
documents v2's surface only. The phone app and desktop app ship v2 bundles only.
