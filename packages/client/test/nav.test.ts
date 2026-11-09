import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNavigation, decodeNav, encodeNav, memoryHistory } from '../src/nav-url.ts';
import { initialNav, navigate, type Intent, type Main, type Nav, type Overlay, type Side } from '../src/nav.ts';
import { createScope } from '../src/scope.ts';
import type { CrewId, ExtensionId, Json, SessionId } from '../src/types.ts';
import { createViews } from '../src/views.ts';
import { prng } from './helpers.ts';

const T1 = 'laptop:0190a1b2-0000-7000-8000-000000000001' as SessionId;
const T2 = 'box:0190a1b2-0000-7000-8000-000000000002' as SessionId;
const viewer: Overlay = { kind: 'viewer', id: 'stuff.viewer' as ExtensionId, params: { item: 'img1' } };
const dialog: Overlay = { kind: 'dialog', id: 'settings.dialog' as ExtensionId, params: null };
const wide = initialNav(1280);
const run = (nav: Nav, ...intents: Intent[]): Nav => intents.reduce(navigate, nav);
const openT1 = run(wide, { t: 'openTask', id: T1 });

test('layout comes from width: split at 900 px and up, stacked below', () => {
  assert.equal(initialNav(899).layout, 'stack');
  assert.equal(initialNav(900).layout, 'split');
  assert.equal(run(wide, { t: 'resize', width: 400 }).layout, 'stack');
  const same = run(wide, { t: 'resize', width: 1000 });
  assert.equal(same, wide, 'a resize inside the same layout changes nothing');
});

test('#573 #574: Open on a toast closes the viewer or dialog over the task', () => {
  const covered = run(openT1, { t: 'openOverlay', overlay: viewer }, { t: 'openOverlay', overlay: dialog });
  assert.equal(covered.overlays.length, 2);
  const opened = run(covered, { t: 'openFromToast', target: { to: 'main', main: { kind: 'task', id: T2 } } });
  assert.deepEqual(opened.main, { kind: 'task', id: T2 });
  assert.deepEqual(opened.overlays, []);
  // the same task as the one under the viewer: still uncovered
  const again = run(covered, { t: 'openFromToast', target: { to: 'main', main: { kind: 'task', id: T1 } } });
  assert.deepEqual(again.overlays, []);
  assert.deepEqual(again.main, { kind: 'task', id: T1 });
  // with nothing over the page, nothing changes (the same object: no history entry)
  assert.equal(run(openT1, { t: 'openFromToast', target: { to: 'main', main: { kind: 'task', id: T1 } } }), openT1);
  // a toast whose Open is itself a viewer replaces whatever was on top
  const toViewer = run(covered, { t: 'openFromToast', target: { to: 'overlay', overlay: viewer } });
  assert.deepEqual(toViewer.overlays, [viewer]);
});

test('#354: marking the open task done goes Home, not to the next task', () => {
  const withSide = run(openT1, { t: 'openSide', side: { kind: 'changes', id: T1 } });
  for (const t of ['markDone', 'archive', 'delete'] as const) {
    const after = run(withSide, { t, id: T1 });
    assert.deepEqual(after.main, { kind: 'home' }, t);
    assert.deepEqual(after.side, { kind: 'none' }, `${t}: the task's side pane goes with it`);
  }
  // another task done from the list: what's open stays
  assert.equal(run(openT1, { t: 'markDone', id: T2 }), openT1);
});

test('#406: renaming a task keeps it open', () => {
  const nav = run(openT1, { t: 'openSide', side: { kind: 'shell', id: T1 } }, { t: 'openOverlay', overlay: dialog });
  assert.equal(run(nav, { t: 'rename', id: T1 }), nav);
});

test('back pops the top overlay, then the side pane, then main', () => {
  let nav = run(openT1, { t: 'openSide', side: { kind: 'pr', id: T1 } }, { t: 'openOverlay', overlay: viewer }, { t: 'openOverlay', overlay: dialog });
  nav = navigate(nav, { t: 'back' });
  assert.deepEqual(nav.overlays, [viewer]);
  nav = navigate(nav, { t: 'back' });
  assert.deepEqual(nav.overlays, []);
  assert.equal(nav.side.kind, 'pr');
  nav = navigate(nav, { t: 'back' });
  assert.equal(nav.side.kind, 'none');
  assert.equal(nav.main.kind, 'task');
  nav = navigate(nav, { t: 'back' });
  assert.equal(nav.main.kind, 'home');
  assert.equal(navigate(nav, { t: 'back' }), nav, 'back on Home is a no-op');
});

test('a side pane belongs to its task: opening another task closes it, opening it brings its task', () => {
  const withShell = run(openT1, { t: 'openSide', side: { kind: 'shell', id: T1 } });
  assert.deepEqual(run(withShell, { t: 'openTask', id: T2 }).side, { kind: 'none' });
  const fromHome = run(wide, { t: 'openSide', side: { kind: 'changes', id: T2 } });
  assert.deepEqual(fromHome.main, { kind: 'task', id: T2 });
  // a plugin's side view is not bound to a task and stays
  const view: Side = { kind: 'view', id: 'git.graph' as ExtensionId };
  assert.deepEqual(run(openT1, { t: 'openSide', side: view }, { t: 'openTask', id: T2 }).side, view);
  assert.equal(run(withShell, { t: 'toggleSide', side: { kind: 'shell', id: T1 } }).side.kind, 'none');
});

test('overlays: a double open is one, closing by id closes what sits above it', () => {
  const once = run(openT1, { t: 'openOverlay', overlay: viewer });
  assert.equal(run(once, { t: 'openOverlay', overlay: viewer }), once);
  const stack = run(once, { t: 'openOverlay', overlay: dialog });
  assert.deepEqual(run(stack, { t: 'closeOverlay', id: viewer.id }).overlays, []);
  assert.deepEqual(run(stack, { t: 'closeOverlay' }).overlays, [viewer]);
});

// ---------- model: random intents keep the invariants ----------

function randomIntent(r: ReturnType<typeof prng>): Intent {
  const id = r.pick([T1, T2]);
  const intents: Intent[] = [
    { t: 'openTask', id },
    { t: 'openCrew', id: 'laptop:c1' as CrewId },
    { t: 'openView', id: 'git.graph' as ExtensionId, params: { repo: 'r1' } },
    { t: 'home' },
    { t: 'openSide', side: { kind: r.pick(['changes', 'shell', 'pr'] as const), id } },
    { t: 'closeSide' },
    { t: 'openOverlay', overlay: r.pick([viewer, dialog]) },
    { t: 'closeOverlay' },
    { t: 'back' },
    { t: 'markDone', id },
    { t: 'rename', id },
    { t: 'openFromToast', target: { to: 'main', main: { kind: 'task', id } } },
    { t: 'resize', width: r.pick([390, 1280]) },
  ];
  return r.pick(intents);
}

test('model: after any intents, a task pane sits beside its own task, a toast leaves nothing over the page, rename never moves', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = prng(seed);
    let nav = wide;
    for (let i = 0; i < 40; i++) {
      const intent = randomIntent(r);
      const next = navigate(nav, intent);
      if (next.side.kind === 'changes' || next.side.kind === 'shell' || next.side.kind === 'pr') {
        assert.deepEqual(next.main, { kind: 'task', id: next.side.id }, `seed ${seed}: ${intent.t}`);
      }
      if (intent.t === 'openFromToast') assert.deepEqual(next.overlays, []);
      if (intent.t === 'rename') assert.equal(next, nav);
      if (intent.t === 'markDone' && nav.main.kind === 'task' && nav.main.id === intent.id) assert.equal(next.main.kind, 'home');
      assert.equal(new Set(next.overlays.map((o) => o.id)).size, next.overlays.length, 'one of each overlay');
      nav = next;
    }
  }
});

// ---------- the URL ----------

test('property: decode(encode(nav)) is nav for every nav state', () => {
  const r = prng(7);
  const mains: Main[] = [{ kind: 'home' }, { kind: 'task', id: T1 }, { kind: 'crew', id: 'box:c/1' as CrewId }, { kind: 'view', id: 'git.graph' as ExtensionId, params: { a: [1, 'x:y'], b: null } }, { kind: 'view', id: 'x.y' as ExtensionId, params: null }];
  const sides: Side[] = [{ kind: 'none' }, { kind: 'changes', id: T2 }, { kind: 'view', id: 'git.graph' as ExtensionId }];
  for (let i = 0; i < 200; i++) {
    const overlays = [viewer, dialog, { kind: 'sheet', id: 'a.b' as ExtensionId, params: 'p:q?&=' as Json } as Overlay].filter(() => r.int(2) === 0);
    const nav = { main: r.pick(mains), side: r.pick(sides), overlays };
    assert.deepEqual(decodeNav(encodeNav(nav)), nav);
  }
  assert.equal(encodeNav({ main: { kind: 'home' }, side: { kind: 'none' }, overlays: [] }), '/');
});

test('a broken or hostile URL lands on Home and never throws', () => {
  for (const url of ['/task/', '/task/%E0%A4%A', '/view/../../etc', '/view/a.b?p={bad', '/nope/x', '/?side=shell:', '/?side=evil:x', '/?o=dialog:a b', '/?o=popup:x', '//', '']) {
    const nav = decodeNav(url);
    assert.ok(nav.main.kind === 'home' || nav.main.kind === 'task', url);
    assert.ok(nav.overlays.every((o) => /^[A-Za-z0-9._-]+$/.test(o.id)), url);
  }
});

test('navigation mirrors the URL: opens push, closes replace, Back restores', () => {
  const scope = createScope();
  const history = memoryHistory('/');
  const views = createViews();
  views.register(scope, { id: 'stuff.viewer', slot: 'overlay', overlay: 'viewer', parse: (p) => p });
  const nav = createNavigation({ scope, width: 1280, history, views });
  nav.navigate({ t: 'openTask', id: T1 });
  nav.navigate({ t: 'openOverlay', overlay: viewer });
  assert.equal(history.entries.length, 3);
  nav.navigate({ t: 'rename', id: T1 });
  assert.equal(history.entries.length, 3, 'rename makes no history entry');
  history.back(); // the browser's Back
  assert.deepEqual(nav.nav().overlays, []);
  assert.deepEqual(nav.nav().main, { kind: 'task', id: T1 });
  nav.navigate({ t: 'back' });
  assert.equal(history.read(), '/');
  scope.dispose();
});

test('a view that is not registered (or was switched off) lands on Home', () => {
  const scope = createScope();
  const plugin = scope.child('plugin:git');
  const views = createViews();
  const graph = views.register(plugin, { id: 'git.graph', slot: 'main', parse: (p) => (typeof p === 'object' && p !== null && !Array.isArray(p) && typeof p['repo'] === 'string' ? { repo: p['repo'] } : undefined) });
  const warnings: string[] = [];
  const nav = createNavigation({ scope, width: 1280, history: memoryHistory('/view/git.graph?p=%7B%22repo%22%3A%22r1%22%7D'), views, warn: (m) => warnings.push(m) });
  assert.deepEqual(nav.nav().main, { kind: 'view', id: 'git.graph', params: { repo: 'r1' } });
  nav.navigate({ t: 'home' });
  nav.navigate(graph.open({ repo: 'r2' }));
  assert.deepEqual(nav.nav().main, { kind: 'view', id: 'git.graph', params: { repo: 'r2' } });
  nav.navigate({ t: 'home' });
  nav.navigate({ t: 'openView', id: 'git.graph' as ExtensionId, params: 'bad' });
  assert.equal(nav.nav().main.kind, 'home', 'params the view refuses');
  plugin.dispose();
  nav.navigate(graph.open({ repo: 'r3' }));
  assert.equal(nav.nav().main.kind, 'home', 'the plugin is off');
  assert.equal(warnings.length, 2);
  scope.dispose();
});

test('a bare task id in a URL is the home peer\'s task: /task/<id> opens it, ?side too (2026-11-09 /task/<id> mounted nothing)', () => {
  const scope = createScope('t');
  const nav = createNavigation({ scope, width: 1440, history: memoryHistory('/task/abc123?side=changes:abc123'), home: 'local' });
  assert.deepEqual(nav.nav().main, { kind: 'task', id: 'local:abc123' });
  assert.deepEqual(nav.nav().side, { kind: 'changes', id: 'local:abc123' });
  // one that names its peer is kept; without a home, ids stay as they are
  const other = createNavigation({ scope, width: 1440, history: memoryHistory('/task/box%3Aabc'), home: 'local' });
  assert.deepEqual(other.nav().main, { kind: 'task', id: 'box:abc' });
  assert.deepEqual(createNavigation({ scope, width: 1440, history: memoryHistory('/task/abc') }).nav().main, { kind: 'task', id: 'abc' });
});
