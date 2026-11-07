import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { discover } from '../check/core/workspace.ts';
import { affectedSet, parseImpact, scorePr, verdict, type PrScore } from '../g14.ts';
import { markdown, readVerify } from '../monoflow-report.ts';
import { MONOFLOW_COMMIT, strays } from '../setup-monoflow.ts';
import { dependencyOrder, plan } from '../test.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wisp-tools-'));
  roots.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

const ws = (name: string, deps: string[] = [], test = true): string => JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((d) => [d, '*'])), scripts: test ? { test: 'node -e 0' } : {} });

test('test.ts: workspaces run in dependency order, ties by name, packages without tests skipped', () => {
  const root = dir({
    'package.json': JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }),
    'packages/kernel/package.json': ws('@w/kernel', ['@w/protocol']),
    'packages/protocol/package.json': ws('@w/protocol'),
    'packages/a-tokens/package.json': ws('@w/tokens'),
    'packages/docs/package.json': ws('@w/docs', [], false),
    'apps/server/package.json': ws('server', ['@w/kernel', 'left-pad']),
  });
  assert.deepEqual(dependencyOrder(discover(root)).map((p) => p.name), ['@w/docs', '@w/protocol', '@w/tokens', '@w/kernel', 'server']);
  const steps = plan(root, { monoflow: false }).map((s) => s.name);
  assert.deepEqual(steps, ['tools', '@w/protocol', '@w/tokens', '@w/kernel', 'server']);
});

test('test.ts: with monoflow installed, packages run through verify --all --test', () => {
  const root = dir({ 'package.json': JSON.stringify({ workspaces: [] }), '.agents/bin/monoflow': '' });
  const steps = plan(root, { monoflow: true });
  assert.deepEqual(steps.map((s) => s.args.join(' ')), ['--test --test-reporter=dot tools/**/*.test.ts', 'verify --all --test']);
  assert.deepEqual(plan(root, { monoflow: false }).length, 1);
});

test('test.ts: dependency cycles still run every package', () => {
  const root = dir({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }), 'packages/a/package.json': ws('a', ['b']), 'packages/b/package.json': ws('b', ['a']) });
  assert.deepEqual(dependencyOrder(discover(root)).map((p) => p.name), ['a', 'b']);
});

test('monoflow-report: both versions of verify --json read the same', () => {
  const pin = readVerify({ status: 'failed', duration_ms: 3000, total_targets: 2, affected_packages: ['b', 'a'], results: [{ target: 'a', status: 'passed', duration_ms: 1000 }, { target: 'b', status: 'failed', duration_ms: 2000 }] });
  assert.deepEqual(pin, { status: 'failed', durationMs: 3000, affected: ['a', 'b'], failed: ['b'], durations: { a: 1, b: 2 }, total: 2, details: [] });
  const later = readVerify({ status: 'failed', duration_ms: 10, total_targets: 3, failed: { c: 2 }, errors: [{ file: 'packages/d', targets: ['d'], message: 'tsc: 2 errors' }] });
  assert.deepEqual(later.failed, ['c', 'd']);
  assert.deepEqual(later.details, ['packages/d: tsc: 2 errors']);
  assert.deepEqual(readVerify('garbage').status, 'unknown');
  const md = markdown('PR', pin, { affected_packages: ['a'], unmapped_files: ['README.md'] });
  assert.match(md, /Failed: `b`/);
  assert.match(md, /1 changed files outside every package/);
});

test('g14: impact in either shape; affected set is owners plus dependents; unmapped files listed', () => {
  assert.deepEqual(parseImpact({ owning_package: 'p', transitive_dependents: ['q'] }), { owner: 'p', dependents: ['q'] });
  assert.deepEqual(parseImpact({ package: 'p', dependent_packages: ['r'] }), { owner: 'p', dependents: ['r'] });
  assert.equal(parseImpact({ file: 'x', impact: 'none (untracked/root file)' }), undefined);
  const asked: string[] = [];
  const impact = (f: string) => {
    asked.push(f);
    return f.startsWith('packages/p/') ? { owner: 'p', dependents: ['q', 'r'] } : f.startsWith('plugins/') ? { owner: 'x', dependents: [] } : undefined;
  };
  const a = affectedSet(['packages/p/src/a.ts', 'packages/p/src/b.ts', 'plugins/x/api/i.ts', 'README.md', 'docs/a.md'], impact);
  assert.deepEqual(a, { affected_packages: ['p', 'q', 'r', 'x'], unmapped_files: ['README.md', 'docs/a.md'] });
  assert.equal(asked.length, 4); // packages/p/src asked once
});

test('g14: a failure outside the affected set is a miss; time saved comes from the full run', () => {
  const full = { status: 'failed', durationMs: 0, affected: [], failed: ['q'], durations: { p: 1, q: 1, r: 2 }, total: 3, details: [] };
  assert.deepEqual(scorePr({ number: 1, affected: ['p', 'q'], unmapped: 0, full }), { number: 1, misses: [], saved: 0.5 });
  assert.deepEqual(scorePr({ number: 2, affected: ['p'], unmapped: 0, full }), { number: 2, misses: ['q'], saved: 0.75 });
  assert.equal(scorePr({ number: 3, affected: [], unmapped: 0, full: undefined }), undefined);
});

test('g14: the gate needs 200 PRs, zero misses and half the time saved', () => {
  const ok = (n: number, saved = 0.6): PrScore[] => Array.from({ length: n }, (_, i) => ({ number: i, misses: [], saved }));
  assert.equal(verdict(ok(200)).pass, true);
  assert.equal(verdict(ok(199)).pass, false);
  assert.equal(verdict(ok(200, 0.4)).pass, false);
  const one = [...ok(199), { number: 999, misses: ['@wisp/store'], saved: 0.9 }];
  const v = verdict(one);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /#999/);
});

test('setup-monoflow: the pin is a full sha; strays from monoflow init are found, a clean repo has none', () => {
  assert.match(MONOFLOW_COMMIT, /^[0-9a-f]{40}$/);
  const root = dir({ 'README.md': '' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.deepEqual(strays(root), []);
  mkdirSync(join(root, '.agents/bin'), { recursive: true });
  writeFileSync(join(root, '.agents/bin/git'), '#!/bin/sh\n');
  writeFileSync(join(root, '.git/hooks/pre-push'), '#!/bin/sh\n# MonoFlow git shield\n');
  writeFileSync(join(root, '.git/hooks/post-merge'), '#!/bin/sh\necho mine\n');
  mkdirSync(join(root, '.opencode'));
  const found = strays(root).join('\n');
  assert.match(found, /\.agents\/bin\/git/);
  assert.match(found, /pre-push/);
  assert.match(found, /\.opencode/);
  assert.doesNotMatch(found, /post-merge/);
});
