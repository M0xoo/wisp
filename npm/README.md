# npm/

How wisp reaches npm: one dependency-free launcher, `wisp-agents`, plus one package per platform
holding the Rust binary (the esbuild model, plan §7.1). npm installs only the platform package that
matches the machine, through `optionalDependencies` and each package's `os`/`cpu`.

| Folder | What it is |
| --- | --- |
| `wisp-agents/` | The published `wisp-agents` package: `bin/wisp.js` (the `wisp` command), `lib/resolve.js` (which binary to run, and the error text), `client.js` + `client.d.ts` (the SDK, `wisp-agents/client`). Release builds add `web/`, the web bundle. |
| `platform/package.template.json` | The `package.json` of each `@wisp/core-<os>-<arch>` package. No `libc` field: the Linux builds are static musl and run on glibc too. |
| `scripts/build.mjs` | Assembles both packages for one target from a built binary. |
| `test/` | `node --test npm/test/` (no network, no real binary). |

## How the launcher runs wisp

1. `WISP_BINARY` set: run that file.
2. Else resolve `@wisp/core-${process.platform}-${process.arch}/package.json` and run its `bin/wisp`
   (`bin/wisp.exe` on Windows). Missing or unsupported: a short error with the fix, exit 1.
3. Set `WISP_WEB_DIR` to the package's `web/` folder, unless it is already set or there is no `web/`.
4. Pass every argument through, forward SIGINT/SIGTERM/SIGHUP, exit with the binary's code or signal.

## Release builds

For each target (`node npm/scripts/build.mjs --list-targets` prints them with their Rust triples):

```sh
cargo build --release -p wisp --target aarch64-unknown-linux-musl
node npm/scripts/build.mjs --target linux-arm64 \
  --binary target/aarch64-unknown-linux-musl/release/wisp --web apps/web/dist
```

This writes `npm/dist/core-linux-arm64/` and `npm/dist/wisp-agents/` (`--out` changes the folder,
`--version` overrides the version, which defaults to `wisp-agents/package.json`'s). Publish every
`core-*` package first, then `wisp-agents` once: it pins all of them at its exact version, so the
version in `wisp-agents/package.json` and the root `Cargo.toml` move together (see the `release` skill).
