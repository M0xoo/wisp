# wisp-native

The one Rust binary in wisp v2 (plan §0.2 item 1): **PTYs and process trees**, nothing else. The
server drives one long-lived helper over stdio ([PROTOCOL.md](PROTOCOL.md)); the Node side, with
the fallback that needs no binary, is [`@wisp/native`](../packages/native).

```
crates/wisp-native/      the binary: protocol, stdout writer, registry, spawn, tree kill
crates/wisp-native-sys/  the reviewed OS calls: kill/killpg, the process table, Job Objects
```

```sh
cargo build --release                 # target/release/wisp-native (the dev lookup finds it)
cargo test                            # unit tests + tests/helper.rs, which drives the real binary
cargo clippy --all-targets -- -D warnings
cargo clippy --target x86_64-pc-windows-msvc -- -D warnings   # Windows code, from a Mac
npm run test:native -w @wisp/native   # release build, then the TS contract + gate G12
```

## Rules (plan §9.2)

- `wisp-native` is `#![forbid(unsafe_code)]` (workspace lint). The OS calls std doesn't have live
  in `wisp-native-sys`, behind safe functions: it denies `unsafe_code`, and each `unsafe` block is
  a single call with `#[allow(unsafe_code)]` and a `SAFETY:` comment (clippy's
  `undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block` are denied). Review that crate
  when it changes; nothing else can hold `unsafe`.
- clippy `pedantic`, with the allow list in `Cargo.toml` (each line says why); `unwrap`, `expect`,
  `panic` denied outside tests; `print_stdout` denied (only `out.rs` writes stdout).
- One `thiserror` error type (`error.rs`) that maps to the wire's `{code, message, retry}`.
- `tracing` span on every command (`cmd{op, id}`), logged to stderr.
- Release profile: `lto`, `strip`, `panic = "abort"`, one codegen unit (1.1 MB on arm64 macOS).

## Dependencies

| crate | why |
|---|---|
| `portable-pty` | PTYs on Unix and ConPTY on Windows (wezterm's; the brief names it) |
| `serde`, `serde_json` | the protocol |
| `base64` | bytes on the wire |
| `thiserror` | the error type |
| `tracing`, `tracing-subscriber` | logs, to stderr |
| `libc` (Unix), `windows-sys` (Windows) | the sys crate's OS calls |

None reaches npm users as a JS dependency: the binary ships prebuilt in the optional
`@wisp/native-<platform>-<arch>` packages (below), and the server works without it.

## Distribution (plan §7.1)

`.github/workflows/native.yml` builds six targets and, when called with `publish: true`, publishes
one npm package per target (the esbuild model). The server's `optionalDependencies` should list
them all at the server's version; npm installs only the one whose `os`/`cpu` match.

| npm package | Rust target | runner |
|---|---|---|
| `@wisp/native-darwin-arm64` | `aarch64-apple-darwin` | macos-14 |
| `@wisp/native-darwin-x64` | `x86_64-apple-darwin` | macos-14 (cross) |
| `@wisp/native-linux-x64` | `x86_64-unknown-linux-musl` (static) | ubuntu-24.04 |
| `@wisp/native-linux-arm64` | `aarch64-unknown-linux-musl` (static) | ubuntu-24.04-arm |
| `@wisp/native-win32-x64` | `x86_64-pc-windows-msvc` | windows-2022 |
| `@wisp/native-win32-arm64` | `aarch64-pc-windows-msvc` | windows-11-arm |

Each package is `{name, version, os: [platform], cpu: [arch], files: ["bin"]}` with the binary at
`bin/wisp-native` (`bin/wisp-native.exe` on Windows). Lookup order in `@wisp/native`:
`WISP_NATIVE_BIN`, then that package, then `native/target/release/wisp-native` (dev); if none is
there, or it doesn't say `hello` within 5 s, the fallback runs. `WISP_NATIVE=0` forces the fallback.
