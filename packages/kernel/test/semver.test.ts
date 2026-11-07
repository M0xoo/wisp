import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, majorOf, parseRange, parseVersion, satisfies, validRange, validVersion } from '../src/index.ts';
import { rng } from './helpers.ts';

test('versions parse; junk does not', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion('v2.0.0-beta.2+build.5')?.pre, ['beta', 2]);
  for (const bad of ['1', '1.2', '01.2.3', '1.2.3.4', 'x', '']) assert.equal(parseVersion(bad), undefined, bad);
  assert.ok(validVersion('0.0.0'));
  assert.ok(!validVersion(1));
  assert.equal(majorOf('3.1.0'), 3);
  assert.equal(majorOf('nope'), undefined);
});

test('pre-releases sort before their release, numbers before words', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  const parsed = sorted.map((v) => parseVersion(v) ?? assert.fail(v));
  for (let i = 1; i < parsed.length; i++) assert.ok(compare(parsed[i - 1] ?? assert.fail(), parsed[i] ?? assert.fail()) < 0, `${sorted[i - 1]} < ${sorted[i]}`);
  assert.equal(compare(parseVersion('1.2.3') ?? assert.fail(), parseVersion('1.2.3') ?? assert.fail()), 0);
});

const cases: [string, string, boolean][] = [
  ['1.2.3', '1.2.3', true],
  ['1.2.4', '1.2.3', false],
  ['1.9.0', '^1', true],
  ['2.0.0', '^1', false],
  ['1.2.0', '^1.2', true],
  ['1.1.9', '^1.2', false],
  ['0.2.5', '^0.2.3', true],
  ['0.3.0', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true],
  ['0.0.4', '^0.0.3', false],
  ['0.9.0', '^0', true],
  ['0.5.0', '^0.x', true],
  ['1.2.9', '~1.2', true],
  ['1.3.0', '~1.2.3', false],
  ['1.9.0', '~1', true],
  ['1.2.0', '>=1.2.0', true],
  ['1.1.0', '>= 1.2', false],
  ['1.9.9', '<2', true],
  ['2.0.0', '<2', false],
  ['2.0.1', '>2', false],
  ['2.0.1', '>2.0.0', true],
  ['2.0.0', '>2.0.0', false],
  ['2.5.0', '>2', false],
  ['3.0.0', '>2', true],
  ['2.0.0', '<=2.0.0', true],
  ['2.9.0', '<=2', true],
  ['3.0.0', '<=2', false],
  ['1.4.0', '1.x', true],
  ['1.2.7', '1.2.*', true],
  ['1.3.0', '1.2.x', false],
  ['5.0.0', '*', true],
  ['5.0.0', 'x', true],
  ['1.5.0', '>=1.2.0 <2', true],
  ['2.0.0', '>=1.2.0 <2', false],
  ['3.1.0', '^1 || ^3', true],
  ['2.1.0', '^1 || ^3', false],
  ['1.0.0', '<*', false],
  ['2.0.0-beta.1', '^1', false],
  ['2.0.0-beta.1', '>=2.0.0-beta', true],
  ['2.0.1-beta.1', '>=2.0.0-beta', false],
  ['2.0.0', '>=2.0.0-beta', true],
  ['1.0.0', '=1.0.0', true],
];

test('ranges match the way npm matches them', () => {
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} ${want ? 'satisfies' : 'does not satisfy'} ${r}`);
});

test('bad ranges and versions satisfy nothing', () => {
  for (const r of ['', '^', '1.2.3.4', 'banana', '>=1.y']) assert.ok(!validRange(r), r);
  assert.ok(!satisfies('1.0.0', 'banana'));
  assert.ok(!satisfies('banana', '*'));
  assert.ok(validRange('^1'));
  assert.ok(Array.isArray(parseRange('  ')));
});

test('property: ^M.m.p holds exactly the same-major versions at or above it (M ≥ 1)', () => {
  const r = rng(7);
  const n = (max: number): number => Math.floor(r() * max);
  for (let i = 0; i < 2000; i++) {
    const [M, m, p] = [1 + n(4), n(5), n(5)];
    const [M2, m2, p2] = [1 + n(4), n(5), n(5)];
    const want = M2 === M && (m2 > m || (m2 === m && p2 >= p));
    assert.equal(satisfies(`${M2}.${m2}.${p2}`, `^${M}.${m}.${p}`), want, `${M2}.${m2}.${p2} vs ^${M}.${m}.${p}`);
  }
});
