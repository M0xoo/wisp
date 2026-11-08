# ADR-0015: The Rust workspace's third-party crates

- Status: accepted
- Date: 2026-11-08
- Source: AGENTS.md ("A new Rust dependency is pinned in the root `Cargo.toml` and justified in an ADR"),
  ADR-0013, docs/v2-quality-audit.md

## Context

ADR-0013 moved everything but the UI to Rust. Agents added crates to the root `Cargo.toml` as their
areas needed them, each with a sentence in a report, but no ADR recorded them. `brotli`, `flate2` and
`windows-sys` were the last ones in without one. This records every third-party crate the workspace
declares, so the next addition has a list to extend and `cargo deny` (`deny.toml`) has a baseline.

## Decision

The workspace depends on exactly these crates, pinned in `[workspace.dependencies]`. Each is there for
the reason given; a crate leaves when its reason does.

| Crate | Why |
|---|---|
| `tokio`, `tokio-util` | the async runtime for every host crate, the edge and the proc service; `tokio-util` for cancellation tokens and codecs (never in a `core` crate) |
| `futures` | `BoxFuture` and stream combinators the kernel's contract uses |
| `async-trait` | object-safe async traits on the channel transports and the grid |
| `bytes` | zero-copy frames on the sync stream and HTTP bodies |
| `hyper`, `hyper-util`, `http`, `http-body-util` | the HTTP edge (wisp-api) and the grid's proxy: HTTP/1 and 2, graceful shutdown |
| `axum` | the stuff plugin's app server (one router, websockets) |
| `reqwest` (rustls) | the net service: outbound HTTPS for harness installs, updates, channels and connectors |
| `url` | parsing and building URLs at the edge, in connectors and the grid |
| `rusqlite` (bundled SQLite) | the store (ADR-0004): WAL, STRICT tables, FTS5, blobs; bundled so every platform has the same SQLite |
| `serde`, `serde_json` | every wire shape and manifest; `raw_value` to pass JSON columns through untouched |
| `ts-rs` | generates `@wisp/protocol`'s TypeScript from the Rust types (AGENTS.md: wire types come from Rust) |
| `thiserror` | one error enum per crate, mapped to `WireError` |
| `tracing`, `tracing-subscriber` | a span per command; the binary's log output (fmt, env filter, JSON) |
| `uuid` (v7) | time-ordered ids for the kernel and the store's epoch |
| `rand` | tokens, passkeys and jitter |
| `regex` | harness command describers, schedule phrases, mentions and connector templates |
| `portable-pty` | PTYs on every OS for the proc service and the terminal plugin |
| `libc` | the reviewed unix calls in `wisp-proc/src/sys` (process groups, signals) |
| `windows-sys` | the reviewed Windows calls in `wisp-proc/src/sys`: Job Objects (a tree killed with 0 orphans, gate G12) and the Toolhelp process table; only the five feature modules listed |
| `blake3` | content addresses for blobs and the edge's ETags |
| `zstd` | blob compression in the store |
| `brotli`, `flate2` | compressed HTTP answers at the edge (`br`, then `gzip`), so the web bundle meets its br budget (ADR-0011) |
| `sha2`, `hmac`, `subtle` | webhook and channel signatures (HMAC-SHA256), compared in constant time |
| `base64` | tokens, signatures and data URLs |
| `ed25519-dalek` | Discord's interaction signatures; the grid's mail inbox checks `ed25519-sha256` DKIM keys |
| `aes-gcm`, `hkdf` | the grid's envelope encryption: each user's data key seals their secrets, wrapped by the master key |
| `scrypt` | the grid's share passkeys, stored as scrypt hashes (v1's scheme, so live links keep working) |
| `rsa`, `p256`, `x509-cert` | the grid's sign-in: OpenID Connect ID tokens signed RS256 or ES256 against the provider's keys; `rsa` also checks `rsa-sha256` DKIM keys (port of v1 `grid/auth/jwt.js`, `grid/dkim.js`) |

`anyhow` and `tower` were declared and used by no crate: removed.

Rules that come with it:

- `core` crates take none of the IO crates (`tokio`, `reqwest`, `axum`, `hyper`, `rusqlite`, `wisp-proc`,
  `wisp-store`): `npm run check` enforces it (`rust-sans-io`).
- Licences are permissive only, advisories and yanked versions fail, and crates come from crates.io:
  `cargo deny check` in CI with `deny.toml`.
- Two advisories are ignored in `deny.toml`, each with its reason: `rsa`'s Marvin attack (RUSTSEC-2023-0071)
  and `crypto-bigint` 0.5's timing (RUSTSEC-2026-0387, through `p256` 0.13). Both need secret inputs; the
  grid only verifies signatures with public keys. Signing or decrypting with either reopens them.
- A new crate gets a row in a later ADR that extends this table (this one is not edited after it merges).

## Consequences

- The dependency list is reviewable in one place, and `cargo deny` fails a PR that brings in a licence or
  an advisory nobody decided on.
- The grid's crypto crates stay out of the wisp binary: only `apps/grid` depends on them.
