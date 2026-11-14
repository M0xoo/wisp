import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { diffProtocol, readProtocol, SNAPSHOT_DIR } from '../protocol-shape.ts';
import { manifests, names, toErrors } from '../rules/manifests.ts';
import { normalizePath, openapi } from '../rules/openapi.ts';
import { protocol } from '../rules/protocol.ts';
import { fixture, messages, run, writeTree } from './helpers.ts';

test('manifests: validator, unique ids, default deny, versioned points, mapped service methods', async () => {
  assert.deepEqual(await run(manifests, fixture('manifests')), [
    'plugins/broken/host/wisp-plugin.json:1 manifests', // not JSON
    'plugins/empty/host/package.json:1 warn:manifests', // host without a manifest
    'plugins/git/api/src/index.ts:10 manifests', // WtService.remove (inherited) unmapped
    'plugins/git/api/src/index.ts:10 warn:manifests', // permission for a method that doesn't exist
    'plugins/git/api/src/index.ts:12 manifests', // permissions not a literal
    'plugins/git/api/src/index.ts:14 manifests', // defineService(id, major, {}) leaves remove unmapped
    'plugins/git/api/src/index.ts:7 manifests', // GitService.push unmapped
    'plugins/git/host/src/index.ts:5 manifests', // registered, not declared
    'plugins/git/host/wisp-plugin.json:11 manifests', // point without a version
    'plugins/git/host/wisp-plugin.json:3 manifests', // id also used by dup
    'plugins/old/host/wisp-plugin.json:1 manifests', // wispPlugin
    'plugins/old/host/wisp-plugin.json:1 manifests', // id
    'plugins/old/host/wisp-plugin.json:1 manifests', // version
    'plugins/old/host/wisp-plugin.json:1 manifests', // api
    'plugins/wt/host/wisp-plugin.json:1 manifests', // the kernel's validator: name required
    'plugins/wt/host/wisp-plugin.json:10 manifests', // wt.remove in no capability set
  ]);
  const all = (await messages(manifests, fixture('manifests'))).join('\n');
  assert.match(all, /wisp-plugin.json:1 manifests name: required/);
  assert.match(all, /command wt.remove is in no capability set/);
  assert.match(all, /method push maps to no permission/);
});

test('manifests: before the kernel exists, warn instead of failing', async () => {
  const root = writeTree(
    new Map([
      ['plugins/a/host/package.json', '{"name":"@f/a"}'],
      ['plugins/a/host/wisp-plugin.json', JSON.stringify({ wispPlugin: 1, id: 'a', version: '1.0.0', api: '^1', contributes: { commands: [{ id: 'a.go', title: 'Go' }] } })],
    ]),
  );
  assert.deepEqual(await run(manifests, root), ['packages/kernel/src/index.ts:1 warn:manifests', 'plugins/a/host/wisp-plugin.json:1 warn:manifests']);
});

test('manifests: capability patterns and validator answers', () => {
  assert.equal(names('git:*', ['git.push', 'git:push']), true);
  assert.equal(names('*', ['git.push']), false); // a bare * grants nothing by name
  assert.equal(names('runtime:start{mode:auto}', ['runtime:start']), true);
  assert.equal(names('git.pu', ['git.push']), false);
  assert.deepEqual(toErrors(true), []);
  assert.deepEqual(toErrors({ ok: true, manifest: {} }), []);
  assert.deepEqual(toErrors({ ok: false, errors: [{ path: 'id', message: 'required' }] }), ['id: required']);
  assert.deepEqual(toErrors(['a', 'b']), ['a', 'b']);
  assert.deepEqual(toErrors(false), ['invalid manifest']);
});

test('openapi: every registered route has an entry; :id and {id} are one parameter', async () => {
  assert.deepEqual(await run(openapi, fixture('openapi')), ['apps/server/src/extra.ts:5 openapi', 'apps/server/src/extra.ts:8 warn:openapi', 'apps/server/src/routes.ts:5 openapi']);
  assert.equal(normalizePath('/api/s/:id/turns/{n}/'), '/api/s/{}/turns/{}');
});

test('openapi: no registry yet is a warning', async () => {
  const root = writeTree(new Map([['apps/server/package.json', '{"name":"@f/server"}'], ['apps/server/src/main.ts', 'export {};']]));
  assert.deepEqual(await run(openapi, root), ['apps/server:1 warn:openapi']);
});

const V1 = `export const PROTO = 2;
export type Topic = 'list' | 'config' | \`session:\${string}\`;
export interface Hello { t: 'hello'; proto: number; build: string; epoch?: string }
export interface Peer { name: string; plugins: { id: string; version: string }[] }
export type Msg = Hello | { t: 'bye'; reason: string } | { t: 'ping' };
export function isTopic(s: string): boolean { return s === 'list'; }
`;

function protocolTree(src: string): string {
  return writeTree(new Map([['packages/protocol/package.json', '{"name":"@f/protocol"}'], ['packages/protocol/src/index.ts', src]]));
}

function snapshot(root: string): void {
  const { lines: _l, ...snap } = readProtocol(root);
  mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
  writeFileSync(join(root, SNAPSHOT_DIR, `proto-${snap.proto}.json`), JSON.stringify(snap));
}

test('protocol: shapes are structural, unions keyed by their discriminant', () => {
  const snap = readProtocol(protocolTree(V1));
  assert.equal(snap.proto, 2);
  assert.deepEqual(Object.keys(snap.types), ['Hello', 'Msg', 'Peer', 'Topic']);
  const msg = snap.types['Msg'];
  assert.ok(msg?.k === 'union');
  assert.deepEqual(Object.keys(msg.members), ['t=bye', 't=hello', 't=ping']);
  const peer = snap.types['Peer'];
  assert.ok(peer?.k === 'object');
  assert.equal(peer.props['plugins']?.s.k, 'array');
});

test('protocol: adding is fine; removing or changing without a PROTO bump fails', async () => {
  const root = protocolTree(V1);
  assert.deepEqual(await run(protocol, root), ['packages/protocol/snapshots:1 warn:protocol']);
  snapshot(root);
  assert.deepEqual(await run(protocol, root), []);

  const added = V1.replace("epoch?: string }", 'epoch?: string; cursor?: number }').replace("'config' |", "'config' | 'crew' |").replace('version: string }', 'version: string; topics: string[] }');
  writeFileSync(join(root, 'packages/protocol/src/index.ts'), added);
  assert.deepEqual(await run(protocol, root), []);

  const broken = V1.replace('build: string;', 'build: number;').replace("'config' |", '').replace('epoch?: string', 'epoch: string').replace('version: string }', '}').replace("| { t: 'bye'; reason: string } ", '');
  writeFileSync(join(root, 'packages/protocol/src/index.ts'), broken);
  const found = await messages(protocol, root);
  const paths = found.map((f) => f.split(' ')[2]);
  assert.deepEqual(paths.sort(), ['Hello.build', 'Hello.epoch', 'Msg|t=bye', 'Peer.plugins[].version', 'Topic|"config"']);
  assert.ok(found.every((f) => f.startsWith('packages/protocol/src/index.ts:')));

  writeFileSync(join(root, 'packages/protocol/src/index.ts'), broken.replace('PROTO = 2', 'PROTO = 3'));
  assert.deepEqual(await run(protocol, root), []);
});

test('protocol: diff reports kinds', () => {
  const a = { types: { X: { k: 'object' as const, props: { a: { opt: false, s: { k: 'text' as const, t: 'string' } } } } } };
  const b = { types: { X: { k: 'object' as const, props: { a: { opt: true, s: { k: 'text' as const, t: 'string' } } } }, Y: { k: 'text' as const, t: 'number' } } };
  assert.deepEqual(diffProtocol(a, b), [
    { path: 'X.a', kind: 'changed', type: 'X' },
    { path: 'Y', kind: 'added', type: 'Y' },
  ]);
});

test('protocol-snapshot: --write saves proto-<PROTO>.json and refuses to rewrite a different one', () => {
  const root = protocolTree(V1);
  const cli = join(import.meta.dirname, '..', 'protocol-snapshot.ts');
  execFileSync(process.execPath, [cli, '--write', `--root=${root}`], { stdio: 'pipe' });
  const saved = JSON.parse(readFileSync(join(root, SNAPSHOT_DIR, 'proto-2.json'), 'utf8'));
  assert.equal(saved.proto, 2);
  writeFileSync(join(root, 'packages/protocol/src/index.ts'), V1.replace('build: string;', 'build: number;'));
  assert.throws(() => execFileSync(process.execPath, [cli, '--write', `--root=${root}`], { stdio: 'pipe' }));
});
