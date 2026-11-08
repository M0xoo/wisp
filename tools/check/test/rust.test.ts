import assert from 'node:assert/strict';
import test from 'node:test';
import { codeLines, header, isTestFile } from '../core/rust.ts';
import { RUST_MAX_FILE, RUST_MAX_FN, longFns, rustLayers, rustManifests, rustSansIo, rustSizes, rustUnsafe } from '../rules/rust.ts';
import { fixture, run, writeTree } from './helpers.ts';

test('rust-layers: plugins use other plugins through -api only; api ↛ core ↛ host; base crates use no plugin', async () => {
  assert.deepEqual(await run(rustLayers, fixture('rust')), [
    'crates/wisp-base/Cargo.toml:6 rust-layers', // a base crate on a plugin's api
    'plugins/git/api/Cargo.toml:4 rust-layers', // api on its own core
    'plugins/git/host/Cargo.toml:7 rust-layers', // another plugin's core
    'plugins/git/host/Cargo.toml:8 rust-layers', // another plugin's host, renamed
  ]);
});

test('rust-sans-io: core crates take no IO dependency and call no fs, net, process or clock outside tests', async () => {
  assert.deepEqual(await run(rustSansIo, fixture('rust')), [
    'plugins/git/core/Cargo.toml:5 rust-sans-io', // tokio
    'plugins/git/core/src/lib.rs:2 rust-sans-io', // use std::fs
    'plugins/git/core/src/lib.rs:5 rust-sans-io', // Instant::now
  ]);
});

test('rust-unsafe: only the reviewed sys module; comments, strings and forbid(unsafe_code) are not unsafe', async () => {
  assert.deepEqual(await run(rustUnsafe, fixture('rust')), ['crates/wisp-proc/src/lib.rs:5 rust-unsafe']);
});

test('rust-manifests: a plugin host needs a manifest Manifest::parse accepts, commands in its namespace and named by a set', async () => {
  const got = await run(rustManifests, fixture('rust'));
  assert.deepEqual(got, [
    'plugins/chat/host/Cargo.toml:1 rust-manifests', // implements Plugin, no manifest
    'plugins/git/host/wisp-plugin.json:1 rust-manifests', // chat.send outside git.*
    'plugins/git/host/wisp-plugin.json:1 rust-manifests', // git.push named by no set
    'plugins/git/host/wisp-plugin.json:1 rust-manifests', // "git.bare" is not {id, title}
  ]);
});

const lines = (n: number, make: (i: number) => string): string => Array.from({ length: n }, (_, i) => make(i)).join('\n');

test('rust-sizes: src files over 400 lines and fns over 60 warn unless a size-ok reason is written; tests are exempt', async () => {
  const body = lines(RUST_MAX_FN, (i) => `    let v${i} = ${i};`);
  const long = lines(RUST_MAX_FILE + 1, (i) => `pub const C${i}: u32 = ${i};`);
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n'],
      ['crates/a/Cargo.toml', '[package]\nname = "a"\n'],
      ['crates/a/src/long.rs', `//! a table\n${long}`],
      ['crates/a/src/long_ok.rs', `//! a table\n//!\n//! size-ok: one row per v1 route\n${long}`],
      ['crates/a/src/fns.rs', `pub fn big() {\n${body}\n}\n// size-ok: one arm per message\n#[must_use]\npub fn big_ok() -> u8 {\n${body}\n    0\n}\npub trait T {\n    fn decl(&self);\n}\nfn small() {}\n`],
      ['crates/a/src/x_tests.rs', long],
      ['crates/a/tests/it.rs', long],
    ]),
  );
  assert.deepEqual(await run(rustSizes, root), ['crates/a/src/fns.rs:1 warn:rust-sizes', 'crates/a/src/long.rs:1 warn:rust-sizes']);
});

test('rust source reading: comments, strings, raw strings and chars are blanked; braces still count', () => {
  const [a, b, c, d] = codeLines('let s = "unsafe {"; // unsafe\nlet r = r#"std::fs"#; /* unsafe */ let c = \'{\';\n/* a\n still */ fn x() {}');
  assert.equal(a, 'let s = ""; ');
  assert.equal(b, "let r = \"\";  let c = ' ';"); // the block comment leaves its spaces
  assert.equal(c, '');
  assert.equal(d, ' fn x() {}');
  assert.deepEqual(longFns(`fn f() {\n    let s = "}";\n${lines(RUST_MAX_FN, () => '    x();')}\n}`).map(([l, n]) => `${l} ${n}`), ['1 f']);
  assert.equal(header('//! one\n//! size-ok: why\nuse x;\n// later: size-ok: no'), '//! one\n//! size-ok: why');
  assert.ok(isTestFile('crates/a/tests/x.rs') && isTestFile('crates/a/src/resolve_tests.rs') && !isTestFile('crates/a/src/contests.rs'));
});
