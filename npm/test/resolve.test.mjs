import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { TARGETS, binaryPath, childEnv, isSupported, locate, missingMessage, packageName, unsupportedMessage } from '../wisp-agents/lib/resolve.js';

const PLATFORMS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'arm'],
  ['win32', 'x64'],
  ['win32', 'arm64'],
];

test('every supported platform maps to its @wisp/core package and binary', () => {
  assert.deepEqual(Object.keys(TARGETS).sort(), PLATFORMS.map((p) => p.join('-')).sort());
  for (const [platform, arch] of PLATFORMS) {
    assert.ok(isSupported(platform, arch));
    assert.equal(packageName(platform, arch), `@wisp/core-${platform}-${arch}`);
    const found = locate({ platform, arch, env: {}, resolvePkg: (id) => path.join('/nm', id) });
    const exe = platform === 'win32' ? 'wisp.exe' : 'wisp';
    assert.equal(found.bin, path.join('/nm', `@wisp/core-${platform}-${arch}`, 'bin', exe));
  }
});

test('binaryPath sits in bin/ next to the package.json', () => {
  assert.equal(binaryPath('/x/pkg/package.json', 'linux'), path.join('/x/pkg', 'bin', 'wisp'));
  assert.equal(binaryPath('/x/pkg/package.json', 'win32'), path.join('/x/pkg', 'bin', 'wisp.exe'));
});

test('WISP_BINARY wins over everything, even on an unsupported platform', () => {
  const found = locate({ platform: 'aix', arch: 'ppc64', env: { WISP_BINARY: '/opt/wisp' }, resolvePkg: () => assert.fail('not resolved') });
  assert.deepEqual(found, { bin: '/opt/wisp' });
});

test('an unsupported platform says so and lists the supported ones', () => {
  const found = locate({ platform: 'freebsd', arch: 'x64', env: {}, resolvePkg: () => assert.fail('not resolved') });
  assert.equal(found.error, unsupportedMessage('freebsd', 'x64'));
  assert.match(found.error, /freebsd-x64/);
  for (const t of Object.keys(TARGETS)) assert.ok(found.error.includes(t), t);
  assert.match(found.error, /WISP_BINARY/);
});

test('a missing platform package names the platform, the package and the fix', () => {
  const found = locate({
    platform: 'linux',
    arch: 'arm64',
    env: {},
    resolvePkg: () => {
      throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
    },
  });
  assert.equal(found.error, missingMessage('linux', 'arm64'));
  const lines = found.error.split('\n');
  assert.ok(lines.length >= 3 && lines.length <= 5, `${lines.length} lines`);
  assert.match(found.error, /linux-arm64/);
  assert.match(found.error, /@wisp\/core-linux-arm64/);
  assert.match(found.error, /npm install -g wisp-agents/);
  assert.match(found.error, /--omit=optional/);
  assert.match(found.error, /--no-optional/);
  assert.match(found.error, /WISP_BINARY/);
});

test('childEnv sets WISP_WEB_DIR only when unset and the folder exists', () => {
  assert.equal(childEnv({}, '/pkg/web', true).WISP_WEB_DIR, '/pkg/web');
  assert.equal(childEnv({}, '/pkg/web', false).WISP_WEB_DIR, undefined);
  assert.equal(childEnv({ WISP_WEB_DIR: '/mine' }, '/pkg/web', true).WISP_WEB_DIR, '/mine');
  const env = { A: '1' };
  childEnv(env, '/pkg/web', true);
  assert.deepEqual(env, { A: '1' }, 'the input env is not mutated');
});
