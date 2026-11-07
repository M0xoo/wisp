// v1 spells as plugins (plan §6.0.1). The fixtures have the shapes of the spells people have today:
// a floating button with a gh data source, a dialog panel with a script, a theme with parts, tokens and
// settings, a palette command with a recipe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertSpell, Kernel, slotInput, spellPluginId } from '../src/index.ts';

const myPrs = {
  wispSpell: 1,
  id: 'my-prs',
  name: 'My PRs',
  version: '1.0.0',
  description: 'A floating button with your open PR count that opens all of them on GitHub.',
  author: '',
  harnesses: ['*'],
  data: { prs: { gh: ['search', 'prs', '--author', '@me', '--state', 'open'], refresh: 120 } },
  buttons: [{ id: 'my-prs-btn', slot: 'float', label: 'My PRs', icon: 'github', badge: { count: 'prs' }, do: { openAll: { data: 'prs', field: 'url' } } }],
};

const usage = {
  wispSpell: 1,
  id: 'claude-usage',
  name: 'Claude usage',
  harnesses: ['claude'],
  when: { hasPr: true },
  data: { today: { wisp: '/usage', refresh: 60 } },
  buttons: [{ id: 'open', slot: 'topbar', label: 'Usage', do: { panel: 'claude-usage' } }],
  chips: [{ label: 'chip with no id or slot' }],
  panels: [
    { id: 'claude-usage', title: 'Claude usage', as: 'dialog', data: ['today'], render: 'usage' },
    { id: 'in-card', as: 'card', slot: 'card.top' },
    { id: 'home', as: 'feed' },
    { id: 'side' },
  ],
  blocks: [{ type: 'usage-chart', fn: 'chart' }],
  script: 'export function usage() { return {} }',
};

const theme = {
  wispSpell: 1,
  id: 'windows-95',
  name: 'Windows 95',
  version: 'not-semver',
  parts: { topbar: { style: { background: '#000080' } }, 'card.menu': { hide: true }, 'list.rows': { compact: true } },
  ui: { tokens: { '--bg': '#008080' }, dark: { '--bg': '#000' }, hide: ['topbar.brand'] },
  settings: { theme: 'light' },
};

const grid = {
  wispSpell: 1,
  id: 'grid-users',
  name: 'Grid users',
  harnesses: ['*'],
  commands: [{ id: 'k0', label: 'Check wisp Grid users', icon: 'server', do: { recipe: 'Grid users' } }, { label: 'no id' }],
  recipes: [{ id: 'r0', name: 'Grid users', prompt: 'check the users' }],
  hooks: [{ on: 'finished', do: 'notify' }],
  slash: [{ name: 'grid' }],
  prompt: 'Be brief.',
  crew: [{ name: 'ops' }],
  wisp: '1.40.0',
  sparkles: true,
};

test('a button spell becomes a declarative plugin with a kit extension and a read permission', () => {
  const r = convertSpell(myPrs);
  assert.ok(r.ok, JSON.stringify(r));
  const m = r.manifest;
  assert.equal(m.id, 'user.my-prs');
  assert.equal(m.trust, 'declarative');
  assert.deepEqual(m.permissions, ['gh:read{cmd:search prs}']);
  const ui = m.contributes?.ui ?? [];
  assert.equal(ui[0]?.id, 'my-prs.my-prs-btn');
  assert.deepEqual(ui[0]?.attachTo, { id: 'shell', input: 'float' });
  assert.equal((ui[0]?.kit as { c: string }).c, 'Button');
  assert.equal(ui[0]?.if, undefined); // harnesses ['*'] narrows nothing
  assert.deepEqual(m.contributes?.['shell.data'], [{ name: 'prs', gh: myPrs.data.prs.gh, refresh: 120 }]);
  assert.equal(m.requires, undefined);
});

test('panels, chips, scripts, harnesses and when', () => {
  const r = convertSpell(usage);
  assert.ok(r.ok, JSON.stringify(r));
  const m = r.manifest;
  assert.equal(m.trust, 'untrusted'); // it has a script
  assert.deepEqual(m.requires, { 'wisp.claude': { version: '*', optional: true } });
  assert.deepEqual(m.permissions, ['topic:read{path:/usage}']);
  const ui = m.contributes?.ui ?? [];
  assert.deepEqual(ui.map((x) => [x.id, `${x.attachTo.id}:${x.attachTo.input}`]), [
    ['claude-usage.open', 'shell:topbar'],
    ['claude-usage.chip0', 'shell.composer:chips'],
    ['claude-usage.claude-usage', 'shell:dialogs'],
    ['claude-usage.in-card', 'shell.card:top'],
    ['claude-usage.home', 'shell.home:feed'],
    ['claude-usage.side', 'shell:panes'],
  ]);
  assert.equal(ui[0]?.if, "session.harness in ['claude'] && session.hasPr == true");
  assert.deepEqual(m.contributes?.blocks, [{ type: 'usage-chart' }]);
  assert.deepEqual(m.contributes?.['shell.blocks'], [{ type: 'usage-chart', fn: 'chart' }]);
  assert.deepEqual(m.contributes?.['shell.sandbox'], [{ script: usage.script }]);
});

test('a theme spell: part styles, hidden parts, props, tokens, and settings it locks', () => {
  const r = convertSpell(theme);
  assert.ok(r.ok, JSON.stringify(r));
  const m = r.manifest;
  assert.equal(m.version, '1.0.0'); // a bad version falls back
  assert.deepEqual(m.contributes?.partStyles, { topbar: { background: '#000080' }, 'card.menu': { display: 'none' }, 'topbar.brand': { display: 'none' } });
  assert.deepEqual(m.contributes?.['shell.partProps'], [{ 'list.rows': { compact: true } }]);
  assert.deepEqual(m.contributes?.['shell.tokens'], [{ tokens: { '--bg': '#008080' }, dark: { '--bg': '#000' } }]);
  assert.deepEqual(m.contributes?.setSettings, { 'shell.theme': 'light' });
});

test('commands, recipes, hooks, slash, prompt and crew; unknown keys are warnings', () => {
  const r = convertSpell(grid);
  assert.ok(r.ok, JSON.stringify(r));
  const m = r.manifest;
  assert.deepEqual(m.contributes?.commands, [{ id: 'grid-users.k0', title: 'Check wisp Grid users' }, { id: 'grid-users.k1', title: 'no id' }]);
  assert.equal((m.contributes?.['shell.actions'] as { command: string }[])[0]?.command, 'grid-users.k0');
  assert.deepEqual(m.contributes?.recipes, grid.recipes);
  assert.deepEqual(m.contributes?.['runtime.hooks'], grid.hooks);
  assert.deepEqual(m.contributes?.['shell.slash'], grid.slash);
  assert.deepEqual(m.contributes?.['runtime.prompt'], [{ text: 'Be brief.' }]);
  assert.deepEqual(m.contributes?.['crew.members'], grid.crew);
  assert.ok(r.warnings.some((w) => w.startsWith('sparkles:')));
  assert.ok(r.warnings.some((w) => w.startsWith('wisp:')));
});

test('what is not a spell is refused', () => {
  assert.equal(convertSpell(null).ok, false);
  assert.equal(convertSpell({ wispSpell: 2, id: 'a' }).ok, false);
  const bad = convertSpell({ wispSpell: 1, id: '-bad' });
  assert.ok(!bad.ok && bad.errors[0]?.path === 'id');
  // the converter's output still goes through validateManifest
  const weird = convertSpell({ wispSpell: 1, id: 'x', name: 'X', settings: { 'a b': () => 1 } });
  assert.ok(weird.ok); // functions are not JSON: dropped to null, still a valid manifest
});

test('a converted spell loads into the kernel, and locks the setting it sets', async () => {
  const k = new Kernel();
  k.register({ wispPlugin: 1, id: 'wisp.shell', version: '2.0.0', api: '^1', contributes: { settings: [{ key: 'shell.theme', type: 'enum', values: ['system', 'light', 'dark'], default: 'system', overridable: true }], points: [{ id: 'shell.tokens', version: 1, kind: 'list' }] } }, { builtin: true });
  const r = convertSpell(theme);
  assert.ok(r.ok);
  k.register(r.manifest);
  await k.start();
  assert.equal(k.settings.get('shell.theme'), 'light');
  assert.equal(k.settings.info('shell.theme')?.lockedBy, spellPluginId('windows-95'));
  assert.equal(k.contributions('shell.tokens').length, 1);
  assert.equal(k.status().find((s) => s.id === 'user.windows-95')?.state, 'active');
  await k.deactivate('user.windows-95');
  assert.equal(k.settings.get('shell.theme'), 'system');
  assert.equal(k.contributions('shell.tokens').length, 0);
});

test('slots map to extension inputs', () => {
  assert.deepEqual(slotInput('composer.bar'), { id: 'shell.composer', input: 'bar' });
  assert.deepEqual(slotInput('float'), { id: 'shell', input: 'float' });
  assert.deepEqual(slotInput('split.head'), { id: 'shell.split', input: 'head' });
});
