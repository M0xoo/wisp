# ADR-0002: TypeScript on Node 22.18+, bundled to one zero-dependency package

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 was untyped JavaScript, with 4 escape helpers and 1,361 `S.x` uses that nothing checked. The plan asks for strict TypeScript, with protocol types generated.

## Decision

- All code is TypeScript with `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. `any` and `@ts-ignore` are banned (`tools/check`).
- Only erasable syntax (`erasableSyntaxOnly`): Node ≥ 22.18 strips types itself, so the server, the tools and the tests run with no build step. Relative imports carry `.ts`.
- The published package `wisp-agents` (`apps/server`) is bundled by esbuild into plain JS, with the web bundle beside it. It has **zero runtime dependencies**, as in v1. Node strips no types inside `node_modules`, so the bundle is required.
- `engines`: Node ≥ 22.18 to develop wisp. The bundle needs `node:sqlite`, so it requires Node ≥ 22.13.

## Consequences

Node 20 is dropped (it has no `node:sqlite`). Dev dependencies are allowed and pinned (TypeScript, esbuild, Vite, Vitest, Solid, Zag). Runtime dependencies stay at zero for the server; the web bundle carries Solid and Zag.
