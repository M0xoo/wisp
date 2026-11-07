import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Manifest, Requirement } from '../src/index.ts';
import { dependentsOf, providerCandidates, resolve, satisfies } from '../src/index.ts';
import { manifest, rng } from './helpers.ts';

test('dependencies come first, ties keep registration order', () => {
  const r = resolve({
    manifests: [manifest('wisp.claude', { kind: 'module', extends: 'wisp.runtime', requires: { 'wisp.git': '^1' } }), manifest('wisp.runtime'), manifest('wisp.git'), manifest('wisp.extra')],
  });
  assert.deepEqual(r.order, ['wisp.runtime', 'wisp.git', 'wisp.claude', 'wisp.extra']);
  assert.equal(r.refused.size, 0);
  assert.deepEqual(r.deps.get('wisp.claude'), ['wisp.runtime', 'wisp.git']);
});

test('the exact refusal: "wisp.claude requires wisp.runtime, which is off"', () => {
  const ms = [manifest('wisp.runtime'), manifest('wisp.claude', { requires: { 'wisp.runtime': '^1' } }), manifest('wisp.crew', { requires: { 'wisp.claude': '^1' } })];
  const r = resolve({ manifests: ms, off: new Map([['wisp.runtime', 'switched off in Settings']]) });
  assert.equal(r.refused.get('wisp.runtime'), 'switched off in Settings');
  assert.equal(r.refused.get('wisp.claude'), 'wisp.claude requires wisp.runtime, which is off');
  assert.equal(r.refused.get('wisp.crew'), 'wisp.crew requires wisp.claude, which is refused (wisp.claude requires wisp.runtime, which is off)');
  assert.deepEqual(r.order, []);
});

test('missing, wrong version, wrong kernel api, extends', () => {
  const r = resolve({
    manifests: [
      manifest('a.one', { requires: { 'a.nothere': '^1' } }),
      manifest('a.two', { requires: { 'a.three': '^2' } }),
      manifest('a.three', { version: '1.4.0' }),
      manifest('a.four', { api: '^9' }),
      manifest('a.five', { kind: 'module', extends: 'a.gone' }),
      manifest('a.six', { requires: { 'a.nothere': { version: '^1', optional: true }, 'a.three': { version: '^2', optional: true } } }),
    ],
  });
  assert.equal(r.refused.get('a.one'), 'a.one requires a.nothere, which is missing');
  assert.equal(r.refused.get('a.two'), 'a.two requires a.three ^2, but 1.4.0');
  assert.equal(r.refused.get('a.four'), 'a.four needs kernel api ^9, this kernel is 1.0.0');
  assert.equal(r.refused.get('a.five'), 'a.five extends a.gone, which is missing');
  assert.ok(r.order.includes('a.six'), 'optional requirements never refuse');
  assert.deepEqual(r.order, ['a.three', 'a.six']);
});

test('cycles refuse every plugin on them, printed; dependents cascade', () => {
  const r = resolve({
    manifests: [
      manifest('c.a', { requires: { 'c.b': '*' } }),
      manifest('c.b', { requires: { 'c.c': '*' } }),
      manifest('c.c', { requires: { 'c.a': '*' } }),
      manifest('c.self', { requires: { 'c.self': '*' } }),
      manifest('c.after', { requires: { 'c.a': '*' } }),
      manifest('c.fine'),
    ],
  });
  assert.equal(r.refused.get('c.a'), 'dependency cycle: c.a → c.b → c.c → c.a');
  assert.equal(r.refused.get('c.b'), 'dependency cycle: c.a → c.b → c.c → c.a');
  assert.equal(r.refused.get('c.self'), 'dependency cycle: c.self → c.self');
  assert.match(r.refused.get('c.after') ?? '', /^c\.after requires c\.a, which is refused \(dependency cycle/);
  assert.deepEqual(r.order, ['c.fine']);
});

test('an optional cycle only orders, it refuses nothing', () => {
  const r = resolve({ manifests: [manifest('o.a', { requires: { 'o.b': { version: '*', optional: true } } }), manifest('o.b', { requires: { 'o.a': { version: '*', optional: true } } })] });
  assert.equal(r.refused.size, 0);
  assert.equal(r.order.length, 2);
});

test('services: required by contract, resolved to a provider; a service cycle is refused', () => {
  const git = manifest('wisp.git', { provides: { 'git.service': { version: '1.3.0' } } });
  const wt = manifest('wisp.worktrees', { requires: { 'git.service': '^1' } });
  const r = resolve({ manifests: [wt, git] });
  assert.deepEqual(r.order, ['wisp.git', 'wisp.worktrees']);
  assert.equal(r.providers.get('git.service'), 'wisp.git');
  const old = resolve({ manifests: [manifest('wisp.worktrees', { requires: { 'git.service': '^2' } }), git] });
  assert.equal(old.refused.get('wisp.worktrees'), 'wisp.worktrees requires git.service ^2, but wisp.git provides 1.3.0');
  const off = resolve({ manifests: [wt, git], off: new Map([['wisp.git', 'off']]) });
  assert.equal(off.refused.get('wisp.worktrees'), 'wisp.worktrees requires git.service, which is missing');
  const cyc = resolve({
    manifests: [manifest('s.a', { provides: { 'a.service': { version: '1.0.0' } }, requires: { 'b.service': '^1' } }), manifest('s.b', { provides: { 'b.service': { version: '1.0.0' } }, requires: { 'a.service': '^1' } })],
  });
  assert.equal(cyc.refused.get('s.a'), 'dependency cycle: s.a → s.b → s.a');
  // a plugin may require the service it provides itself
  assert.deepEqual(resolve({ manifests: [manifest('s.self', { provides: { 'x.service': { version: '1.0.0' } }, requires: { 'x.service': '^1' } })] }).order, ['s.self']);
});

test('provider choice: the user’s pick, else an override, else the first registered; refused ones are skipped', () => {
  const a = manifest('wisp.git', { provides: { 'git.service': { version: '1.0.0' } } });
  const b = manifest('acme.jj', { provides: { 'git.service': { version: '1.1.0' } } });
  const c = manifest('acme.remote', { provides: { 'git.service': { version: '1.2.0' } } });
  assert.deepEqual(providerCandidates({ manifests: [a, b, c] }).get('git.service'), ['wisp.git', 'acme.jj', 'acme.remote']);
  assert.equal(resolve({ manifests: [a, b, c] }).providers.get('git.service'), 'wisp.git');
  assert.equal(resolve({ manifests: [a, b, c], overrides: new Set(['acme.remote']) }).providers.get('git.service'), 'acme.remote');
  assert.equal(resolve({ manifests: [a, b, c], overrides: new Set(['acme.remote']), choices: new Map([['git.service', 'acme.jj']]) }).providers.get('git.service'), 'acme.jj');
  assert.equal(resolve({ manifests: [a, b], off: new Map([['wisp.git', 'off']]) }).providers.get('git.service'), 'acme.jj');
});

test('dependentsOf walks the reverse graph', () => {
  const deps = new Map([
    ['b', ['a']],
    ['c', ['b']],
    ['d', ['x']],
  ]);
  assert.deepEqual(dependentsOf('a', deps), ['b', 'c']);
  assert.deepEqual(dependentsOf('x', deps), ['d']);
  assert.deepEqual(dependentsOf('c', deps), []);
});

// ---------- model test: random plugin sets against the rules ----------

function randomSet(seed: number, services = true): { ms: Manifest[]; off: Map<string, string> } {
  const r = rng(seed);
  const n = 2 + Math.floor(r() * 10);
  const ids = Array.from({ length: n }, (_, i) => `m.p${i}`);
  const ms = ids.map((id) => {
    const requires: Record<string, string | Requirement> = {};
    for (const other of [...ids, 'm.ghost', 'svc.one']) {
      if (other === id || r() > 0.2) continue;
      const version = r() < 0.8 ? '^1' : '^2';
      requires[other] = r() < 0.3 ? { version, optional: true } : version;
    }
    const provides = r() < 0.2 && services ? { 'svc.one': { version: r() < 0.7 ? '1.0.0' : '2.0.0' } } : undefined;
    return manifest(id, { version: r() < 0.9 ? '1.0.0' : '2.0.0', requires, ...(provides && { provides }) });
  });
  const off = new Map(ids.filter(() => r() < 0.1).map((id) => [id, 'off'] as const));
  return { ms, off };
}

test('model: every resolved plugin has its hard requirements resolved before it, every refusal has a reason', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { ms, off } = randomSet(seed);
    const r = resolve({ manifests: ms, off });
    const pos = new Map(r.order.map((id, i) => [id, i]));
    const byId = new Map(ms.map((m) => [m.id, m]));
    for (const m of ms) {
      const inOrder = pos.has(m.id);
      assert.notEqual(inOrder, r.refused.has(m.id), `seed ${seed}: ${m.id} is either resolved or refused`);
      if (off.has(m.id)) assert.ok(!inOrder, `seed ${seed}: ${m.id} is off`);
      if (!inOrder) {
        assert.ok((r.refused.get(m.id) ?? '').length > 0, `seed ${seed}: ${m.id} has a reason`);
        continue;
      }
      for (const [dep, req] of Object.entries(m.requires ?? {})) {
        const range = typeof req === 'string' ? req : req.version;
        if (typeof req === 'object' && req.optional) continue;
        const target = byId.has(dep) ? dep : r.providers.get(dep);
        assert.ok(target !== undefined && pos.has(target), `seed ${seed}: ${m.id} needs ${dep}, which must be resolved`);
        assert.ok((pos.get(target) ?? 0) <= (pos.get(m.id) ?? 0), `seed ${seed}: ${dep} before ${m.id}`);
        const version = byId.has(dep) ? byId.get(dep)?.version : byId.get(target)?.provides?.[dep]?.version;
        if (target !== m.id) assert.ok(satisfies(version ?? '', range), `seed ${seed}: ${dep}@${version} satisfies ${range}`);
      }
    }
    assert.deepEqual(resolve({ manifests: ms, off }).order, r.order, `seed ${seed}: deterministic`);
  }
});

// Not with services: turning a provider off can hand the contract to another plugin, which may then
// satisfy a requirement the first one didn't. That is the provider choice working, not a leak.
test('model: switching one more plugin off never brings another one on (no services)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { ms, off } = randomSet(seed, false);
    const before = new Set(resolve({ manifests: ms, off }).order);
    const victim = ms[seed % ms.length]?.id ?? '';
    const after = resolve({ manifests: ms, off: new Map([...off, [victim, 'off']]) }).order;
    for (const id of after) assert.ok(before.has(id) || id === victim, `seed ${seed}: ${id} came on when ${victim} went off`);
    assert.ok(!after.includes(victim));
  }
});
