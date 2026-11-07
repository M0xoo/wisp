import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStoreHost, type StoreDecl } from '../src/define-store.ts';
import { createI18n } from '../src/i18n.ts';
import { memoryPersist } from '../src/persist.ts';
import { createScope } from '../src/scope.ts';

type View = { mode: 'list' | 'grid'; zoom: number };
const isView = (v: unknown): View | undefined => {
  const o = v as Partial<View> | null;
  return o && (o.mode === 'list' || o.mode === 'grid') && typeof o.zoom === 'number' ? { mode: o.mode, zoom: o.zoom } : undefined;
};
const decl = (over: Partial<StoreDecl<View>> = {}): StoreDecl<View> => ({ id: 'myplugin.view', version: 2, defaults: { mode: 'list', zoom: 1 }, check: isView, persist: true, ...over });

test('defineStore: a value set is kept and read back by the next run', async () => {
  const persist = memoryPersist();
  const s1 = createStoreHost({ persist }).define('myplugin', createScope(), decl());
  await s1.ready;
  s1.set({ mode: 'grid', zoom: 2 });
  await new Promise((r) => setImmediate(r));
  const s2 = createStoreHost({ persist }).define('myplugin', createScope(), decl());
  await s2.ready;
  assert.deepEqual(s2.value(), { mode: 'grid', zoom: 2 });
});

test('defineStore: an old version is migrated', async () => {
  const persist = memoryPersist();
  await persist.write([{ ns: 'store:myplugin', key: 'myplugin.view', value: { version: 1, data: { grid: true } } }]);
  const s = createStoreHost({ persist }).define('myplugin', createScope(), decl({ migrate: (old) => ({ mode: (old as { grid: boolean }).grid ? 'grid' : 'list', zoom: 1 }) }));
  await s.ready;
  assert.deepEqual(s.value(), { mode: 'grid', zoom: 1 });
  assert.deepEqual(await persist.get('store:myplugin', 'myplugin.view'), { version: 2, data: { mode: 'grid', zoom: 1 } }, 'written back in the new shape');
});

test('defineStore: a migration that fails, or data that fails the check, resets to defaults with a warning', async () => {
  for (const saved of [
    { version: 1, data: { grid: true } }, // migrate throws
    { version: 2, data: { mode: 'carousel', zoom: 1 } }, // fails the check
    { version: 9, data: {} }, // from a newer plugin
    'garbage',
  ]) {
    const persist = memoryPersist();
    const warnings: string[] = [];
    await persist.write([{ ns: 'store:myplugin', key: 'myplugin.view', value: saved }]);
    const s = createStoreHost({ persist, warn: (m) => warnings.push(m) }).define(
      'myplugin',
      createScope(),
      decl({
        migrate: () => {
          throw new Error('cannot read v1');
        },
      }),
    );
    await s.ready;
    assert.deepEqual(s.value(), { mode: 'list', zoom: 1 }, JSON.stringify(saved));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /reset to defaults/);
    s.set({ mode: 'grid', zoom: 3 });
    assert.equal(s.value().zoom, 3, 'the plugin keeps working');
  }
});

test('defineStore: namespaced by plugin id, memory-only unless declared, dropped with the scope', async () => {
  const persist = memoryPersist();
  const host = createStoreHost({ persist });
  assert.throws(() => host.define('other', createScope(), decl()), /can't define the store myplugin.view/);
  const scope = createScope();
  const s = host.define('myplugin', scope, decl({ persist: false }));
  s.set({ mode: 'grid', zoom: 5 });
  await new Promise((r) => setImmediate(r));
  assert.equal(await persist.get('store:myplugin', 'myplugin.view'), undefined);
  assert.throws(() => host.define('myplugin', createScope(), decl()), /twice/);
  scope.dispose();
  s.set({ mode: 'list', zoom: 9 });
  assert.equal(s.value().zoom, 5, 'a dropped store takes no writes');
  host.define('myplugin', createScope(), decl()); // the id is free again
});

test('i18n: per-plugin catalogues, vars, plurals; a missing key renders as itself and warns once', () => {
  const warnings: string[] = [];
  const i18n = createI18n({ dev: true, warn: (m) => warnings.push(m) });
  const scope = createScope();
  i18n.register('crew', { 'crew.title': 'Crew', 'crew.hired': 'Hired {name}', 'crew.count.one': '{count} member', 'crew.count.other': '{count} members' }, scope);
  assert.equal(i18n.t('crew.title'), 'Crew');
  assert.equal(i18n.t('crew.hired', { name: 'Ada' }), 'Hired Ada');
  assert.equal(i18n.t('crew.hired'), 'Hired {name}', 'a missing var stays visible');
  assert.equal(i18n.t('crew.count', { count: 1 }), '1 member');
  assert.equal(i18n.t('crew.count', { count: 3 }), '3 members');
  assert.equal(i18n.t('crew.nope'), 'crew.nope');
  assert.equal(i18n.t('crew.nope'), 'crew.nope');
  assert.deepEqual(warnings, ['missing string crew.nope']);
  assert.throws(() => i18n.register('git', { 'crew.title': 'stolen' }, scope), /keys start with "git."/);
  scope.dispose();
  assert.equal(i18n.t('crew.title'), 'crew.title', 'switched off with its plugin');
  const before = warnings.length;
  assert.equal(createI18n({ warn: (m) => warnings.push(m) }).t('x.y'), 'x.y');
  assert.equal(warnings.length, before, 'no warning outside dev');
});
