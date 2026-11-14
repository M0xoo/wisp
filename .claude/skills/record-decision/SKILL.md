---
name: record-decision
description: Use when a change makes or changes an architecture decision in wisp (a new package kind, dependency, kind of state, wire message, extension point kind, or a tools/check rule turned off), to record it as an ADR in docs/adr in the same PR.
---

# Record an architecture decision

1. Check `docs/adr/README.md`: if an ADR already covers it, you are *changing* that decision, so write a new
   ADR that supersedes it. Never edit a merged ADR, except to set its Status to `superseded by ADR-00NN`.
2. Copy the shape of an existing ADR into `docs/adr/00NN-<short-slug>.md` (the next number):
   `# ADR-00NN: <decision as a sentence>`, then Status / Date / Source, then **Context** (what forced it,
   with numbers), **Decision** (what we do, as rules someone can check), **Consequences** (what it costs,
   what it rules out).
3. Add its row to `docs/adr/README.md`.
4. If it's a rule, make it checkable: add it to `tools/check/rules/` with a test, or say in the ADR why it
   can't be checked.
5. If it changes the map, update `ARCHITECTURE.md`. If it changes how people work, update `AGENTS.md`.
6. `.agents/bin/monoflow verify --affected` and `npm run check` pass before you hand back.
