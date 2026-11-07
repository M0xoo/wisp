import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { type LocateDeps, NATIVE_TARGETS, binaryName, locateBinary, nativePackageName } from '../src/locate.ts';
import { startNative } from '../src/index.ts';
import { NativeError } from '../src/errors.ts';

const deps = (files: string[], over: Partial<LocateDeps> = {}): LocateDeps => ({
  env: {},
  platform: 'darwin',
  arch: 'arm64',
  exists: (f) => files.includes(f),
  packageDir: (name) => (name === '@wisp/native-darwin-arm64' ? '/nm/@wisp/native-darwin-arm64' : null),
  devRoot: '/repo/native',
  ...over,
});

test('lookup order: WISP_NATIVE_BIN, then the platform package, then the dev build', () => {
  const all = ['/opt/wn', '/nm/@wisp/native-darwin-arm64/bin/wisp-native', '/repo/native/target/release/wisp-native'];
  assert.deepEqual(locateBinary(deps(all, { env: { WISP_NATIVE_BIN: '/opt/wn' } })), { binary: '/opt/wn', source: 'env' });
  assert.deepEqual(locateBinary(deps(all)), { binary: all[1], source: 'package' });
  assert.deepEqual(locateBinary(deps(all.slice(2))), { binary: all[2], source: 'dev' });
});

test('a missing binary says everywhere it looked', () => {
  const r = locateBinary(deps([], { env: { WISP_NATIVE_BIN: '/gone' }, packageDir: () => null }));
  assert.equal(r.binary, null);
  assert.match(r.binary === null ? r.reason : '', /WISP_NATIVE_BIN=\/gone \(missing\).*@wisp\/native-darwin-arm64 \(not installed\).*not built/);
});

test('package names follow Node platform/arch, the esbuild model', () => {
  assert.equal(nativePackageName('win32', 'x64'), '@wisp/native-win32-x64');
  assert.equal(binaryName('win32'), 'wisp-native.exe');
  assert.equal(binaryName('linux'), 'wisp-native');
  const names = NATIVE_TARGETS.map((t) => nativePackageName(t.platform, t.arch));
  assert.deepEqual(names, ['@wisp/native-darwin-arm64', '@wisp/native-darwin-x64', '@wisp/native-linux-x64', '@wisp/native-linux-arm64', '@wisp/native-win32-x64', '@wisp/native-win32-arm64']);
  assert.ok(NATIVE_TARGETS.filter((t) => t.platform === 'linux').every((t) => t.rust.endsWith('-musl')), 'linux is static musl');
  assert.equal(path.basename(binaryName('darwin')), 'wisp-native');
});

test('no binary: auto falls back and says why; native refuses; WISP_NATIVE=0 forces the fallback', async () => {
  const none = { packageDir: () => null, devRoot: '/nowhere', exists: () => false };
  const logs: string[] = [];
  const host = await startNative({ env: {}, locate: none, log: (l) => logs.push(l) });
  assert.equal(host.info.kind, 'fallback');
  assert.match(host.info.reason ?? '', /no wisp-native binary/);
  assert.equal(logs.length, 1);
  await host.close();
  await assert.rejects(startNative({ env: {}, locate: none, prefer: 'native' }), (e: unknown) => e instanceof NativeError && e.code === 'unsupported');
  const off = await startNative({ env: { WISP_NATIVE: '0' } });
  assert.deepEqual(off.info, { kind: 'fallback', reason: 'turned off by WISP_NATIVE' });
  await off.close();
});

test('a binary that never says hello falls back instead of hanging', async () => {
  // `true` exits at once without a hello: the host gives up and the fallback takes over.
  const host = await startNative({ env: { WISP_NATIVE_BIN: '/usr/bin/true' }, locate: { exists: (f) => f === '/usr/bin/true' } });
  assert.equal(host.info.kind, 'fallback');
  assert.match(host.info.reason ?? '', /didn't start/);
  await host.close();
});
