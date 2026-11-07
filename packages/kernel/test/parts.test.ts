// The kernel's building blocks on their own: groups, scopes, settings, list points, diagnostics.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, createScope, Diagnostics, pluginGroup, pointRef, Points, resolve, Ring, SettingsRegistry, type Json } from '../src/index.ts';
import { manifest, rng } from './helpers.ts';

const entry = (id: string) => ({ manifest: manifest(id) });

test('groups: disable keeps the slot, addAfter/addBefore insert, set replaces in place', () => {
  const Default = pluginGroup('default', [entry('wisp.runtime'), entry('wisp.git'), entry('wisp.telemetry')]);
  const g = build(Default).disable('wisp.telemetry').addAfter('wisp.runtime', entry('me.mine')).addBefore('wisp.runtime', entry('me.first')).add(entry('me.last')).finish('mine');
  assert.equal(g.id, 'mine');
  assert.deepEqual(g.entries.map((e) => `${e.entry.manifest.id}${e.enabled ? '' : ' (off)'}`), ['me.first', 'wisp.runtime', 'me.mine', 'wisp.git', 'wisp.telemetry (off)', 'me.last']);
  const back = build(g).enable('wisp.telemetry').set({ manifest: manifest('wisp.git', { version: '3.0.0' }) });
  assert.deepEqual(back.ids(), ['me.first', 'wisp.runtime', 'me.mine', 'wisp.git', 'wisp.telemetry', 'me.last']);
  assert.equal(back.finish().entries[3]?.entry.manifest.version, '3.0.0');
  assert.ok(Default.entries.every((e) => e.enabled), 'groups are data: building never changes the original');
  assert.ok(Object.isFrozen(g.entries));
  assert.throws(() => build(Default).disable('nope'), /has no plugin nope/);
  assert.throws(() => build(Default).add(entry('wisp.git')), /already has wisp\.git/);
  assert.throws(() => pluginGroup('x', [entry('a.b'), entry('a.b')]), /listed twice/);
});

test('scopes dispose in reverse, children first, once; a failing disposer does not stop the rest', () => {
  const log: string[] = [];
  const errors: unknown[] = [];
  const s = createScope('p', { onError: (e) => errors.push(e) });
  s.add(() => log.push('first'));
  const c = s.child('c');
  c.add({ dispose: () => log.push('child') });
  s.add(() => {
    throw new Error('boom');
  });
  s.add(() => log.push('last'));
  assert.equal(s.alive, true);
  s.dispose();
  s.dispose();
  assert.deepEqual(log, ['last', 'child', 'first']);
  assert.equal(errors.length, 1);
  assert.equal(s.alive, false);
  assert.equal(c.alive, false);
  assert.equal(s.signal.aborted, true);
  s.add(() => log.push('late')); // too late to own it: freed at once
  assert.equal(log.at(-1), 'late');
  assert.equal(s.size, 0);
});

test('a child disposed on its own leaves its parent', () => {
  const s = createScope('p');
  const c = s.child('c');
  assert.equal(s.size, 1);
  c.dispose();
  assert.equal(s.size, 0);
});

test('scope timers fire unless the scope went first; callbacks that throw are reported', async () => {
  const errors: unknown[] = [];
  const s = createScope('t', { onError: (e) => errors.push(e) });
  let fired = 0;
  let ticks = 0;
  s.timeout(5, () => fired++);
  s.timeout(5, () => {
    throw new Error('timer boom');
  });
  s.interval(2, () => ticks++);
  const gone = createScope('gone');
  let late = 0;
  gone.timeout(5, () => late++);
  gone.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 1);
  assert.equal(late, 0);
  assert.equal(errors.length, 1);
  assert.ok(ticks >= 2);
  assert.equal(s.size, 1, 'a fired timeout leaves the scope; the interval stays');
  s.dispose();
  const after = ticks;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ticks, after);
});

test('settings: typed, defaults, locks win until released, watchers see the effective value', () => {
  const saved: [string, Json | undefined, string][] = [];
  const reg = new SettingsRegistry({ load: (scope) => (scope === 'server' ? { 'claude.turns': 7 } : {}), save: (k, v, scope) => saved.push([k, v, scope]) });
  const d = reg.declare('wisp.claude', [
    { key: 'claude.model', type: 'enum', values: ['auto', 'opus'], default: 'auto', overridable: true },
    { key: 'claude.turns', type: 'int', min: 1, max: 40, default: 10 },
    { key: 'claude.compact', type: 'bool', default: false, scope: 'device' },
  ]);
  assert.equal(reg.get('claude.turns'), 7, 'a saved value beats the default');
  const seen: (Json | undefined)[] = [];
  const w = reg.watch('claude.model', (v) => seen.push(v));
  reg.set('claude.model', 'opus');
  assert.throws(() => reg.set('claude.model', 'gpt'), /must be one of auto, opus/);
  assert.throws(() => reg.set('nope.x', 1), /no plugin declares the setting nope\.x/);
  const lock = reg.lock('user.theme', 'claude.model', 'auto');
  assert.equal(reg.info('claude.model')?.lockedBy, 'user.theme');
  assert.throws(() => reg.set('claude.model', 'opus'), (e: { code: string }) => e.code === 'conflict');
  assert.throws(() => reg.lock('user.other', 'claude.model', 'opus'), /locked by user\.theme/);
  assert.throws(() => reg.lock('user.theme', 'claude.turns', 3), /doesn't let other plugins set it/);
  assert.throws(() => reg.lock('user.x', 'claude.model', 'gpt'), /locked by/);
  lock.dispose();
  lock.dispose();
  assert.equal(reg.get('claude.model'), 'opus');
  reg.set('claude.model', undefined);
  assert.equal(reg.get('claude.model'), 'auto');
  assert.deepEqual(seen, ['opus', 'auto', 'opus', 'auto']);
  reg.set('claude.compact', true);
  assert.deepEqual(saved.at(-1), ['claude.compact', true, 'device']);
  assert.deepEqual(reg.list('device').map((i) => i.key), ['claude.compact']);
  assert.equal(reg.list().length, 3);
  assert.throws(() => reg.declare('wisp.other', [{ key: 'claude.model', type: 'string' }]), /already declared by wisp\.claude/);
  assert.equal(reg.watcherCount, 1);
  w.dispose();
  assert.equal(reg.watcherCount, 0);
  d.dispose();
  assert.equal(reg.info('claude.model'), undefined);
  const r2 = new SettingsRegistry();
  r2.declare('a.b', [{ key: 'b.x', type: 'int', overridable: true }]);
  assert.throws(() => r2.lock('c.d', 'b.x', 'one'), /must be a whole number/);
});

test('list points: versions, kinds, owners, waiting contributions', () => {
  const p = new Points();
  assert.deepEqual(pointRef('runtime.harness@2'), { id: 'runtime.harness', version: 2 });
  assert.deepEqual(pointRef('runtime.harness'), { id: 'runtime.harness', version: undefined });
  const early = p.contribute('wisp.codex', 'runtime.harness', { id: 'codex' }, true);
  assert.throws(() => p.contribute('wisp.x', 'runtime.nope', {}), /no plugin declares the point runtime\.nope/);
  const decl = p.declare('wisp.runtime', [{ id: 'runtime.harness', version: 1, kind: 'list' }, { id: 'runtime.before', version: 1, kind: 'interceptor' }]);
  assert.deepEqual(p.entries('runtime.harness'), [{ by: 'wisp.codex', item: { id: 'codex' } }]);
  const c = p.contribute('wisp.claude', 'runtime.harness@1', { id: 'claude' });
  assert.throws(() => p.contribute('wisp.claude', 'runtime.harness@2', {}), /declares version 1/);
  assert.throws(() => p.contribute('wisp.claude', 'runtime.before', {}), /interceptor point, not a list/);
  assert.throws(() => p.declare('wisp.other', [{ id: 'runtime.harness', version: 1, kind: 'list' }]), /already declared by wisp\.runtime/);
  assert.equal(p.owner('runtime.harness'), 'wisp.runtime');
  assert.equal(p.decl('runtime.harness')?.version, 1);
  assert.equal(p.countBy('wisp.claude'), 1);
  c.dispose();
  assert.equal(p.countBy('wisp.claude'), 0);
  decl.dispose(); // the owner goes: contributions wait for it to come back
  assert.throws(() => p.entries('runtime.harness'), /no plugin declares/);
  assert.equal(p.countBy('wisp.codex'), 1);
  p.declare('wisp.runtime', [{ id: 'runtime.harness', version: 1, kind: 'list' }]);
  assert.equal(p.entries('runtime.harness').length, 1);
  early.dispose();
  assert.equal(p.entries('runtime.harness').length, 0);
  const w = p.contribute('a.b', 'later.point', 1, true);
  w.dispose();
  assert.equal(p.countBy('a.b'), 0);
});

test('diagnostics keep the last N per plugin and the refused calls', () => {
  const d = new Diagnostics(3);
  for (let i = 0; i < 5; i++) d.record({ at: i, plugin: 'a.b', kind: 'command', code: 'internal', message: `m${i}` });
  assert.deepEqual(d.failures('a.b').map((f) => f.message), ['m2', 'm3', 'm4']);
  d.refuse({ at: 9, plugin: 'a.c', kind: 'command', code: 'forbidden', message: 'no', stack: ['x:y'] });
  assert.equal(d.refusals()[0]?.code, 'forbidden');
  assert.equal(d.failures('a.c').length, 1);
  assert.deepEqual(d.failures('none'), []);
  const r = new Ring<number>(0);
  r.push(1);
  r.push(2);
  assert.deepEqual(r.list(), [2]);
});

test('model: without services, resolution does not depend on registration order', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const n = 2 + Math.floor(r() * 8);
    const ids = Array.from({ length: n }, (_, i) => `q.p${i}`);
    const ms = ids.map((id) => manifest(id, { requires: Object.fromEntries(ids.filter((o) => o !== id && r() < 0.25).map((o) => [o, r() < 0.3 ? { version: '*', optional: true } : '*'])) }));
    const shuffled = [...ms].sort(() => r() - 0.5);
    const a = resolve({ manifests: ms });
    const b = resolve({ manifests: shuffled });
    assert.deepEqual([...a.refused.keys()].sort(), [...b.refused.keys()].sort(), `seed ${seed}`);
    assert.deepEqual([...a.order].sort(), [...b.order].sort(), `seed ${seed}`);
  }
});
