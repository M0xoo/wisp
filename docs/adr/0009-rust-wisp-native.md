# ADR-0009: Rust stays in wisp-native: the PTY and process trees

- Status: superseded by ADR-0013
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

The owner asked for a Rust backend. The plan's measurements (§2.2, review #2) show a full port would buy the start time and memory of a process that isn't wisp's bottleneck, and would lose zero-dependency `npm i` and the remote bootstrap.

## Decision

- **wisp-native** (`native/`, Cargo): one small static binary that the server drives over stdio with JSON lines. It provides PTYs (portable-pty) and process trees (process groups on Unix, Job Objects on Windows). It exits when stdin closes.
- `@wisp/native` finds the binary (`WISP_NATIVE_BIN`, then `@wisp/native-<os>-<arch>` optionalDependencies as esbuild does, then a dev build). Without one it falls back to v1's Python `pty.fork` helper and `taskkill`, so an install never breaks.
- Porting the API to Rust is gate G11: only for a bottleneck measured after G1 and G3 that Node can't fix.

## Consequences

Only wisp-native needs per-platform binaries (`.github/workflows/native.yml`).
