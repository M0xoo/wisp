import assert from 'node:assert/strict';
import test from 'node:test';
import { codeLines, header, isTestFile } from '../core/rust.ts';
import { RUST_MAX_FILE, RUST_MAX_FN, eventsInCode, longFns, rustEvents, rustLayers, rustManifests, rustMcp, rustMcpOwners, rustPath, rustSansIo, rustSetExt, rustSizes, rustTypedCommands, rustUnsafe } from '../rules/rust.ts';
import { fixture, messages, run, writeTree } from './helpers.ts';

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
    'plugins/stub/host/Cargo.toml:1 rust-manifests', // every host crate is a plugin: it implements none
    'plugins/stub/host/Cargo.toml:1 rust-manifests', // … and has no manifest
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

test('rust-sizes: a size-ok reason under more comment lines ends the scan (it used to loop forever)', () => {
  const body = lines(RUST_MAX_FN + 5, () => '    x();');
  const src = `// one\n// two\n// size-ok: one straight pass\n// three\n#[inline]\nfn long() {\n${body}\n}\n// no reason\nfn other() {\n${body}\n}`;
  assert.deepEqual(longFns(src).map(([, n]) => n), ['other']);
});

test('rust-layers: a plugin tui crate uses its api and other plugins\' api; never a host, and no host uses it (ADR-0024)', async () => {
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["plugins/*/api", "plugins/*/host", "plugins/*/tui"]\n'],
      ['plugins/shop/api/Cargo.toml', '[package]\nname = "wisp-shop-api"\n'],
      ['plugins/shop/host/Cargo.toml', '[package]\nname = "wisp-shop"\n\n[dependencies]\nwisp-shop-tui.workspace = true\n'],
      ['plugins/shop/tui/Cargo.toml', '[package]\nname = "wisp-shop-tui"\n\n[dependencies]\nwisp-shop-api.workspace = true\nwisp-shop.workspace = true\nwisp-till-api.workspace = true\nwisp-till.workspace = true\n'],
      ['plugins/till/api/Cargo.toml', '[package]\nname = "wisp-till-api"\n'],
      ['plugins/till/host/Cargo.toml', '[package]\nname = "wisp-till"\n'],
    ]),
  );
  const got = await messages(rustLayers, root);
  assert.equal(got.length, 3, got.join('\n'));
  assert.ok(got.some((m) => m.includes('wisp-shop-tui depends on wisp-shop ') && m.includes('side by side')));
  assert.ok(got.some((m) => m.includes('wisp-shop depends on wisp-shop-tui') && m.includes('side by side')));
  assert.ok(got.some((m) => m.includes('wisp-shop-tui depends on wisp-till ') && m.includes('api crate only')));
});

test('rust-events: emitted_type_missing_from_manifest_fails_check (and a listed type nobody emits, and durable as in the code)', async () => {
  const cargo = '[package]\nname = "wisp-shop"\n';
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["plugins/*/api", "plugins/*/host"]\n'],
      ['plugins/shop/api/Cargo.toml', '[package]\nname = "wisp-shop-api"\n'],
      [
        'plugins/shop/api/src/lib.rs',
        [
          'impl Event for Sold {',
          '    const TYPE: &\'static str = "shop.sold";',
          '    const DURABLE: bool = true;',
          '}',
          'impl Event for Seen {',
          '    const TYPE: &\'static str = "shop.seen";',
          '}',
          'event!(Opened = "shop.opened");',
          '#[cfg(test)]',
          'mod tests { impl Event for T { const TYPE: &\'static str = "test.only"; } }',
        ].join('\n'),
      ],
      ['plugins/shop/host/Cargo.toml', cargo],
      ['plugins/shop/host/src/lib.rs', 'impl Plugin for Shop {}'],
      ['plugins/shop/host/wisp-plugin.json', JSON.stringify({ wispPlugin: 1, id: 'wisp.shop', contributes: { events: [{ type: 'shop.sold', durable: false }, 'shop.seen', 'shop.gone'] } })],
    ]),
  );
  const got = await messages(rustEvents, root);
  assert.equal(got.length, 3, got.join('\n'));
  assert.ok(got.some((m) => m.includes('shop.opened is emitted')));
  assert.ok(got.some((m) => m.includes('shop.sold is durable in the code')));
  assert.ok(got.some((m) => m.includes('lists shop.gone')));
  assert.deepEqual([...eventsInCode('durable!(X = "a.b", |e| subject: 1, key: 2);')], [['a.b', true]]);
});

test('rust-mcp: a listed command its host never registers is no MCP tool; uiOnly says why (ADR-0040)', async () => {
  const cargo = '[package]\nname = "wisp-shop"\n';
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["plugins/*/api", "plugins/*/host", "plugins/*/core"]\n'],
      ['plugins/shop/api/Cargo.toml', '[package]\nname = "wisp-shop-api"\n'],
      ['plugins/shop/api/src/lib.rs', ['command!(List = "shop.list" read yes : Value => Value);', 'command!(', '    /// buy one', '    Buy = "shop.buy" : Value => Value', ');', 'command!(Run, "shop.run", Value, Value);', 'impl Command for Peek { const ID: &\'static str = "shop.peek"; type Args = (); }', 'command!(Gone = "shop.gone" : Value => Value);', 'command!(Sell = "shop.sell" : Value => Value);'].join('\n')],
      ['plugins/shop/host/Cargo.toml', cargo],
      ['plugins/shop/host/src/lib.rs', ['use wisp_shop_api::{Run as RunCmd};', 'impl Plugin for Shop {}', 's.command::<api::List, _, _>(f);', 'on!(s, st, c::Buy, |st, a| x);', 's.command::<RunCmd, _, _>(g);', 's.command::<Peek, _, _>(h);', 'on!(api::Sell, |p, ctx, a| p.sell(&ctx, &a).await);'].join('\n')],
      ['plugins/shop/host/wisp-plugin.json', JSON.stringify({ wispPlugin: 1, id: 'wisp.shop', contributes: { commands: [{ id: 'shop.list', title: 'l' }, { id: 'shop.buy', title: 'b' }, { id: 'shop.run', title: 'r' }, { id: 'shop.peek', title: 'p' }, { id: 'shop.gone', title: 'g' }, { id: 'shop.sell', title: 's' }, { id: 'shop.pane', title: 'p', uiOnly: 'only a screen can drag it' }, { id: 'shop.lazy', title: 'z', uiOnly: 'ui' }] } })],
    ]),
  );
  const got = await messages(rustMcp, root);
  assert.equal(got.length, 2, got.join('\n'));
  assert.ok(got.some((m) => m.includes('shop.gone is listed but its host registers it nowhere')));
  assert.ok(got.some((m) => m.includes('shop.lazy: "uiOnly" says why')));
});

test('rust-mcp-owners: an MCP tool whose owner command no Rust host registers fails the check (ADR-0040)', async () => {
  const cargo = (n: string): string => `[package]\nname = "${n}"\n`;
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["plugins/*/api", "plugins/*/host"]\n'],
      ['plugins/shop/api/Cargo.toml', cargo('wisp-shop-api')],
      ['plugins/shop/api/src/lib.rs', ['command!(AgentBuy = "shop.agent.buy" : Value => Value);', 'command!(AgentSell = "shop.agent.sell" : Value => Value);', 'command!(List = "shop.list" : Value => Value);', 'command!(Peek = "shop.peek" : Value => Value);'].join('\n')],
      ['plugins/shop/host/Cargo.toml', cargo('wisp-shop')],
      ['plugins/shop/host/src/lib.rs', ['impl Plugin for Shop {}', 's.command::<c::AgentBuy, _, _>(f);', 's.command::<c::List, _, _>(g);'].join('\n')],
      ['plugins/mcp/api/Cargo.toml', cargo('wisp-mcp-api')],
      ['plugins/mcp/api/src/owners.rs', ['pub const BUY: &str = "shop.agent.buy"; // registered', 'pub const SELL: &str = "shop.agent.sell"; // declared, never registered'].join('\n')],
      ['plugins/mcp/host/Cargo.toml', cargo('wisp-mcp')],
      ['plugins/mcp/host/src/run.rs', ['use wisp_shop_api::commands as sh;', 'let a = typed::<sh::List>(ctx, call, x).await;', 'let b = typed_json::<sh::Peek>(ctx, call, x).await;', 'let c = ctx.run::<wisp_shop_api::Peek>(call, x).await;', 'let d = ctx.run::<C>(call, x).await;', 'owner(ctx, call, owners::BUY, args)', 'owner(ctx, call, &format!("shop.{}", name), args)'].join('\n')],
    ]),
  );
  const got = await run(rustMcpOwners, root);
  assert.deepEqual(got, [
    'plugins/mcp/api/src/owners.rs:2 rust-mcp-owners', // SELL: no host registers shop.agent.sell
    'plugins/mcp/host/src/run.rs:3 rust-mcp-owners', // typed_json::<sh::Peek>: shop.peek is never registered
    'plugins/mcp/host/src/run.rs:4 rust-mcp-owners', // ctx.run::<wisp_shop_api::Peek>
    'plugins/mcp/host/src/run.rs:7 rust-mcp-owners', // an owner id built at run time
  ]);
  assert.ok((await messages(rustMcpOwners, root)).some((m) => m.includes('owners::SELL = "shop.agent.sell": no host registers it')));
});

test('rust-typed-commands: a string-name call to another plugin\'s typed command fails with the type; a typed call or a `// by-name:` reason does not (ADR-0003)', async () => {
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["plugins/*/api", "plugins/*/host"]\n'],
      ['plugins/shop/api/Cargo.toml', '[package]\nname = "wisp-shop-api"\n'],
      ['plugins/shop/api/src/lib.rs', 'command!(Buy = "shop.buy" : Value => Value);'],
      ['plugins/till/host/Cargo.toml', '[package]\nname = "wisp-till"\n'],
      [
        'plugins/till/host/src/lib.rs',
        [
          'async fn pay(ctx: &Ctx, call: &Call) {',
          '    let _ = ctx.run_json(call, "shop.buy", json!({ "n": 1 })).await;', // the finding
          '    let _ = ctx.run::<wisp_shop_api::Buy>(call, Args { n: 1 }).await;', // typed: none
          '    let _ = ctx.run_json(call, "shop.untyped", json!({})).await;', // no typed command: none
          '    // ctx.run_json(call, "shop.buy", json!({}))', // a comment: none
          '    // by-name: a peer\'s command, over its HTTP edge',
          '    let _ = peer_cmd(ch, "shop.buy", json!({})).await;', // a reason on the line above: none
          '    let _ = peer_cmd(ch, "shop.buy", json!({})).await; // by-name: a peer\'s command', // on its line: none
          '    // by-name:',
          '    let _ = peer_cmd(ch, "shop.buy", json!({})).await;', // no reason given: the finding
          '}',
          '#[cfg(test)]',
          'mod tests { fn t() { ctx.run_json(call, "shop.buy", json!({})); } }', // tests: none
        ].join('\n'),
      ],
    ]),
  );
  assert.deepEqual(await run(rustTypedCommands, root), ['plugins/till/host/src/lib.rs:10 rust-typed-commands', 'plugins/till/host/src/lib.rs:2 rust-typed-commands']);
  const [m] = await messages(rustTypedCommands, root);
  assert.ok(m?.includes('wisp_shop_api::Buy'), m);
});

test('rust-set-ext: a SetExtArgs with `expect: None` (or from a variable) fails unless a `// set-ext: whole <why>` says why; expect set, the api crate and tests do not', async () => {
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["plugins/*/api", "plugins/*/host"]\n'],
      ['plugins/runtime/api/Cargo.toml', '[package]\nname = "wisp-runtime-api"\n'],
      ['plugins/runtime/api/src/lib.rs', 'fn f() { let _ = SetExtArgs { id, plugin, value, expect: None }; }'], // the api crate: none
      ['plugins/till/host/Cargo.toml', '[package]\nname = "wisp-till"\n'],
      [
        'plugins/till/host/src/lib.rs',
        [
          'async fn a(ctx: &Ctx) {',
          '    let _ = SetExtArgs { id: id.into(), plugin: P.into(), value, expect: None };', // 2: the finding
          '    let _ = SetExtArgs { id: id.into(), plugin: P.into(), value, expect: Some(ExtExpect { value: v }) };', // expect set: none
          '    let _ = SetExtArgs { id, plugin, value, expect };', // 4: a variable hides which: the finding
          '    // set-ext: whole one writer, nothing read back',
          '    let _ = SetExtArgs { id, plugin, value, expect: None };', // a reason on the line above: none
          '    let _ = SetExtArgs {', // 7: spans lines, no reason: the finding
          '        id: id.into(),',
          '        plugin: P.into(),',
          '        value: json!({ "a": { "b": 1 } }),',
          '        expect: None,',
          '    };',
          '    let _ = SetExtArgs {',
          '        id, plugin, value,',
          '        expect: None, // set-ext: whole the task was made just now',
          '    };', // a reason inside it: none
          '    // set-ext: whole',
          '    let _ = SetExtArgs { id, plugin, value, expect: None };', // 18: no reason given: the finding
          '    // SetExtArgs { id, plugin, value, expect: None }', // a comment: none
          '    let _ = r::SetExtArgs { id, plugin, value, expect: None }; // set-ext: whole on its line',
          '    let _ = SetExtArgs { id, plugin, value, expect: None };', // 21: the reason above is the last literal's: the finding
          '    let _ = SetExtArgs { id, plugin, value, ..base };', // 22: `..rest` leaves expect None: the finding
          '    let _ = SetExtArgs { id, plugin, value, expect: Some(e) }; let o = Other { expect: None };', // another literal after it: none
          '    let _ = SetExtArgs { id, plugin, value, expect: was }; // set-ext: whole the caller passes None only at boot',
          '}',
          '#[cfg(test)]',
          'mod tests { fn t() { SetExtArgs { id, plugin, value, expect: None }; } }', // tests: none
        ].join('\n'),
      ],
      ['plugins/till/host/tests/race.rs', 'fn t() { SetExtArgs { id, plugin, value, expect: None }; }'], // a test file: none
    ]),
  );
  assert.deepEqual(await run(rustSetExt, root), [
    'plugins/till/host/src/lib.rs:18 rust-set-ext',
    'plugins/till/host/src/lib.rs:2 rust-set-ext',
    'plugins/till/host/src/lib.rs:21 rust-set-ext',
    'plugins/till/host/src/lib.rs:22 rust-set-ext',
    'plugins/till/host/src/lib.rs:4 rust-set-ext',
    'plugins/till/host/src/lib.rs:7 rust-set-ext',
  ]);
  const [m] = await messages(rustSetExt, root);
  assert.ok(m?.includes('update_ext'), m);
});

test('rust-path: env::var("PATH")/var_os("PATH") outside crates/wisp-proc fails unless a `// path: inherited <why>` says why; comments, wisp-proc and tests do not', async () => {
  const root = writeTree(
    new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["crates/*", "plugins/*/host"]\n'],
      ['crates/wisp-proc/Cargo.toml', '[package]\nname = "wisp-proc"\n'],
      ['crates/wisp-proc/src/local.rs', 'fn f() { std::env::var_os("PATH"); }'], // the PATH's home: none
      ['plugins/lens/host/Cargo.toml', '[package]\nname = "wisp-lens"\n'],
      [
        'plugins/lens/host/src/lib.rs',
        [
          'fn a() {',
          '    let p = std::env::var("PATH").unwrap_or_default();', // 2: the finding
          '    let q = env::var_os( "PATH" );', // 3: the finding
          '    // path: inherited a CLI run from a terminal',
          '    let r = std::env::var_os("PATH");', // a reason on the line above: none
          '    let s = std::env::var("PATH"); // path: inherited the grid is a server', // a reason on its line: none
          '    // path: inherited',
          '    let t = std::env::var("PATH");', // 8: no reason given: the finding
          '    // std::env::var("PATH") would be wrong here', // a comment: none
          '    let u = std::env::var("HOME");', // another variable: none
          '    let v = wisp_proc::search_path();', // the way: none
          '    let w = 1; // path: inherited this line only',
          '    let x = std::env::var("PATH");', // 13: the reason above is another line's: the finding
          '    let y = var_os("PATH");', // 14: imported from std::env: the finding
          '    let z = w.var("PATH");', // another type's lookup: none
          '}',
          '#[cfg(test)]',
          'mod tests { fn t() { std::env::var("PATH"); } }', // tests: none
        ].join('\n'),
      ],
      ['plugins/lens/host/tests/path.rs', 'fn t() { std::env::var("PATH"); }'], // a test file: none
      ['plugins/lens/host/src/run_tests.rs', 'fn t() { std::env::var("PATH"); }'], // a test module file: none
      ['plugins/lens/host/src/unix.rs', 'fn a() {}\n#[cfg(all(test, unix))]\nmod tests { fn t() { std::env::var("PATH"); } }'], // a platform's tests: none
      ['plugins/lens/host/src/real.rs', '#[cfg(not(test))]\nfn a() { std::env::var("PATH"); }'], // 2: not(test) is code: the finding
    ]),
  );
  assert.deepEqual(await run(rustPath, root), [
    'plugins/lens/host/src/lib.rs:13 rust-path',
    'plugins/lens/host/src/lib.rs:14 rust-path',
    'plugins/lens/host/src/lib.rs:2 rust-path',
    'plugins/lens/host/src/lib.rs:3 rust-path',
    'plugins/lens/host/src/lib.rs:8 rust-path',
    'plugins/lens/host/src/real.rs:2 rust-path',
  ]);
  const [m] = await messages(rustPath, root);
  assert.ok(m?.includes('search_path'), m);
});
