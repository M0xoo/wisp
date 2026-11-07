import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingProblem, validateManifest, type ManifestError } from '../src/index.ts';

// plan §6.2's example, in the contract's shape
const claude = {
  wispPlugin: 1,
  id: 'wisp.claude',
  version: '2.0.0',
  api: '^1',
  kind: 'module',
  extends: 'wisp.runtime',
  requires: { 'wisp.git': { version: '^2', optional: true }, 'git.service': '^1' },
  provides: { 'claude.models': { version: '1.0.0' } },
  permissions: ['proc:spawn{bin:claude}', 'fs:read{scope:workspace}', 'net:none', 'secrets:read{key:claude.*}'],
  server: { builtin: 'wisp_plugin_claude' },
  activation: ['onCommand:runtime.start{harness:claude}', 'onTopic:session:*', 'onView:claude.panel', 'onBlock:claude.usage', 'onSchedule:nightly', 'onStartup'],
  disable: ['shell.composer.model'],
  contributes: {
    'runtime.harness': [{ id: 'claude', label: 'Claude Code', models: 'dynamic' }],
    'runtime.block@1': [{ type: 'usage' }],
    commands: [{ id: 'claude.login', title: 'Sign in to Claude Code', optimistic: 'none' }],
    events: ['claude.loggedIn'],
    topics: ['plugin:wisp.claude:usage'],
    points: [{ id: 'claude.model', version: 1, kind: 'list' }],
    settings: [
      { key: 'claude.model', type: 'enum', values: ['auto', 'opus', 'sonnet'], default: 'auto', overridable: true },
      { key: 'claude.turns', type: 'int', min: 1, max: 40, default: 10, scope: 'device' },
    ],
    setSettings: { 'shell.theme': 'dark' },
    ui: [
      { id: 'claude.model-picker', attachTo: 'shell.composer:left', component: './ui#ModelPicker', if: "session.harness == 'claude'", priority: 2 },
      { id: 'claude.badge', attachTo: { id: 'shell.card', input: 'head' }, kit: { c: 'Chip', label: 'Claude' } },
    ],
    parts: ['claude.badge'],
    partStyles: { 'card.title': { color: 'red' } },
    icons: ['claude'],
    blocks: [{ type: 'claude.usage', schema: { type: 'object' } }],
    recipes: [{ name: 'Review', prompt: 'review it' }],
  },
  migrations: 'migrations/',
  trust: 'trusted',
};

const errorsOf = (m: unknown): ManifestError[] => {
  const r = validateManifest(m);
  return r.ok ? [] : r.errors;
};
const at = (m: unknown, path: string): string => errorsOf(m).find((e) => e.path === path)?.message ?? '';
const with_ = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...claude, ...patch });
const contrib = (patch: Record<string, unknown>): Record<string, unknown> => with_({ contributes: { ...claude.contributes, ...patch } });

test('a full manifest validates, and attachTo strings are normalised', () => {
  const r = validateManifest(claude);
  assert.ok(r.ok, JSON.stringify(errorsOf(claude)));
  assert.deepEqual(r.manifest.contributes?.ui?.[0]?.attachTo, { id: 'shell.composer', input: 'left' });
  assert.deepEqual(r.manifest.contributes?.['runtime.harness'], claude.contributes['runtime.harness']);
  assert.ok(validateManifest({ wispPlugin: 1, id: 'acme.thing', version: '0.1.0', api: '^1' }).ok);
});

test('not an object, wrong wispPlugin, bad id, version and api', () => {
  assert.deepEqual(errorsOf(null), [{ path: '', message: 'a manifest is a JSON object' }]);
  assert.equal(at(with_({ wispPlugin: 2 }), 'wispPlugin'), 'must be 1');
  assert.match(at(with_({ id: 'Claude' }), 'id'), /owner-prefixed/);
  assert.match(at(with_({ id: 'claude' }), 'id'), /owner-prefixed/);
  assert.match(at(with_({ version: '2' }), 'version'), /semver version/);
  assert.match(at(with_({ api: 'one' }), 'api'), /semver range/);
  assert.match(at(with_({ name: 3 }), 'name'), /string/);
  assert.match(at(with_({ kind: 'thing' }), 'kind'), /plugin" or "module/);
  assert.match(at(with_({ trust: 'yes' }), 'trust'), /declarative/);
});

test('unknown keys are refused with what was meant', () => {
  assert.match(at(with_({ permisions: [] }), 'permisions'), /did you mean "permissions"/);
  assert.match(at(with_({ buttons: [] }), 'buttons'), /wispSpell key; in a plugin it is contributes\.ui/);
  assert.match(at(with_({ wispSpell: 1 }), 'wispSpell'), /convertSpell/);
  assert.match(at(with_({ zzzzzzzz: 1 }), 'zzzzzzzz'), /known keys: wispPlugin/);
  assert.match(at(contrib({ comands: [] }), 'contributes.comands'), /did you mean "commands"/);
  assert.match(at(contrib({ commands: [{ id: 'claude.x', title: 'X', label: 'x' }] }), 'contributes.commands[0].label'), /unknown key/);
  assert.match(at(with_({ requires: { 'wisp.git': { version: '^1', optonal: true } } }), 'requires.wisp.git.optonal'), /did you mean "optional"/);
});

test('modules and extends go together', () => {
  assert.match(at(with_({ extends: undefined }), 'extends'), /a module extends exactly one plugin/);
  assert.match(at(with_({ kind: 'plugin' }), 'kind'), /only a module extends/);
  assert.match(at(with_({ extends: 'Runtime' }), 'extends'), /plugin id/);
});

test('requires and provides', () => {
  assert.match(at(with_({ requires: [] }), 'requires'), /must map/);
  assert.match(at(with_({ requires: { 'wisp.git': 'banana' } }), 'requires.wisp.git'), /not a semver range/);
  assert.match(at(with_({ requires: { Git: '^1' } }), 'requires.Git'), /plugin id or a service/);
  assert.match(at(with_({ requires: { 'wisp.git': { version: 'x.y.z' } } }), 'requires.wisp.git.version'), /semver range/);
  assert.match(at(with_({ requires: { 'wisp.git': { version: '^1', optional: 'yes' } } }), 'requires.wisp.git.optional'), /true or false/);
  assert.match(at(with_({ requires: { 'wisp.git': 2 } }), 'requires.wisp.git'), /range or/);
  assert.match(at(with_({ provides: [] }), 'provides'), /must map/);
  assert.match(at(with_({ provides: { 'git.service': { version: '^1' } } }), 'provides.git.service'), /version: "1.3.0"/);
  assert.match(at(with_({ provides: { X: { version: '1.0.0' } } }), 'provides.X'), /contract id/);
});

test('permissions and activation follow their grammars', () => {
  assert.match(at(with_({ permissions: ['proc:spawn{bin}'] }), 'permissions[0]'), /not k:v/);
  assert.match(at(with_({ permissions: 'git:push' }), 'permissions'), /list of strings/);
  assert.match(at(with_({ permissions: [''] }), 'permissions[0]'), /non-empty/);
  assert.match(at(with_({ activation: ['onBoot'] }), 'activation[0]'), /not an activation event/);
  assert.match(at(with_({ activation: ['onCommand:'] }), 'activation[0]'), /onCommand:<name>/);
  assert.match(at(with_({ activation: ['onStartup:now'] }), 'activation[0]'), /is not onStartup/);
});

test('server is builtin or exec, never both', () => {
  assert.ok(validateManifest(with_({ server: { exec: ['node', 'x.ts'] } })).ok);
  for (const s of [{ exec: [] }, { builtin: 'a', exec: ['b'] }, 'builtin', { wasm: 'x.wasm' }]) assert.match(at(with_({ server: s }), 'server'), /builtin|exec/);
});

test('every contributed id carries the owner prefix', () => {
  assert.match(at(contrib({ commands: [{ id: 'runtime.start', title: 'x' }] }), 'contributes.commands[0].id'), /must start with this plugin's prefix \("claude\." or "wisp\.claude\."\)/);
  assert.match(at(contrib({ events: ['turn.finished'] }), 'contributes.events[0]'), /prefix/);
  assert.match(at(contrib({ points: [{ id: 'runtime.harness', version: 1, kind: 'list' }] }), 'contributes.points[0].id'), /prefix/);
  assert.match(at(contrib({ settings: [{ key: 'model', type: 'string' }] }), 'contributes.settings[0].key'), /prefix/);
  // ui ids are the exception: reusing one is an override
  assert.equal(at(contrib({ ui: [{ id: 'shell.task', attachTo: 'shell:main', kit: {} }] }), 'contributes.ui[0].id'), '');
  assert.match(at(contrib({ ui: [{ attachTo: 'shell:main', kit: {} }] }), 'contributes.ui[0].id'), /non-empty/);
});

test('commands, points and list shapes', () => {
  assert.match(at(contrib({ commands: [{ id: 'claude.a', title: 'A' }, { id: 'claude.a', title: 'B' }] }), 'contributes.commands[1].id'), /listed twice/);
  assert.match(at(contrib({ commands: [{ id: 'claude.a' }] }), 'contributes.commands[0].title'), /title/);
  assert.match(at(contrib({ commands: [{ id: 'claude.a', title: 'A', optimistic: 'yes' }] }), 'contributes.commands[0].optimistic'), /none/);
  assert.match(at(contrib({ commands: {} }), 'contributes.commands'), /list/);
  assert.match(at(contrib({ commands: [3] }), 'contributes.commands[0]'), /\{id, title\}/);
  assert.match(at(contrib({ commands: [{ id: '', title: 'x' }] }), 'contributes.commands[0].id'), /non-empty/);
  assert.match(at(contrib({ points: [{ id: 'claude.p', kind: 'list' }] }), 'contributes.points[0].version'), /every extension point has a version/);
  assert.match(at(contrib({ points: [{ id: 'claude.p', version: 1, kind: 'tree' }] }), 'contributes.points[0].kind'), /list/);
  assert.match(at(contrib({ points: 'x' }), 'contributes.points'), /list/);
  assert.match(at(contrib({ points: [1] }), 'contributes.points[0]'), /\{id, version, kind\}/);
  assert.match(at(with_({ contributes: [] }), 'contributes'), /object/);
  assert.match(at(contrib({ 'runtime.harness': [() => 1] }), 'contributes.runtime.harness'), /plain JSON/);
});

test('settings are typed, and defaults must fit', () => {
  const s = (d: Record<string, unknown>): Record<string, unknown> => contrib({ settings: [{ key: 'claude.x', ...d }] });
  assert.match(at(s({ type: 'float' }), 'contributes.settings[0].type'), /one of string, int/);
  assert.match(at(s({ type: 'enum' }), 'contributes.settings[0].values'), /lists its values/);
  assert.match(at(s({ type: 'int', min: 5, max: 1 }), 'contributes.settings[0].min'), /above max/);
  assert.match(at(s({ type: 'int', min: 'a' }), 'contributes.settings[0].min'), /number/);
  assert.match(at(s({ type: 'int', default: 1.5 }), 'contributes.settings[0].default'), /whole number/);
  assert.match(at(s({ type: 'bool', scope: 'cloud' }), 'contributes.settings[0].scope'), /server/);
  assert.match(at(s({ type: 'bool', overridable: 'yes' }), 'contributes.settings[0].overridable'), /true or false/);
  assert.match(at(contrib({ settings: {} }), 'contributes.settings'), /list/);
  assert.match(at(contrib({ settings: [1] }), 'contributes.settings[0]'), /key, type/);
  assert.match(at(contrib({ setSettings: { 'claude.model': 'opus' } }), 'contributes.setSettings.claude.model'), /own setting/);
  assert.match(at(contrib({ setSettings: [] }), 'contributes.setSettings'), /must map/);
});

test('settingProblem checks each type', () => {
  assert.equal(settingProblem({ type: 'string' }, 'x'), undefined);
  assert.match(settingProblem({ type: 'string' }, 1) ?? '', /string/);
  assert.match(settingProblem({ type: 'bool' }, 'true') ?? '', /true or false/);
  assert.match(settingProblem({ type: 'enum', values: ['a'] }, 'b') ?? '', /one of a/);
  assert.match(settingProblem({ type: 'enum' }, 'b') ?? '', /one of/);
  assert.match(settingProblem({ type: 'int', min: 2 }, 1) ?? '', /at least 2/);
  assert.match(settingProblem({ type: 'int', max: 2 }, 3) ?? '', /at most 2/);
  assert.equal(settingProblem({ type: 'int', min: 1, max: 3 }, 2), undefined);
  assert.equal(settingProblem({ type: 'json' }, { a: [1, null] }), undefined);
  assert.match(settingProblem({ type: 'json' }, new Date()) ?? '', /plain JSON/);
  assert.match(settingProblem({ type: 'json' }, Number.NaN) ?? '', /plain JSON/);
});

test('ui extensions: attachTo, component, kit, if, priority', () => {
  const u = (x: Record<string, unknown>): Record<string, unknown> => contrib({ ui: [{ id: 'claude.e', ...x }] });
  assert.match(at(u({ attachTo: 'nocolon', kit: {} }), 'contributes.ui[0].attachTo'), /parent\.id:input/);
  assert.match(at(u({ attachTo: { id: 'shell', input: 'x', extra: 1 }, kit: {} }), 'contributes.ui[0].attachTo.extra'), /unknown/);
  assert.match(at(u({ attachTo: 'shell:x', component: 'ui/Picker' }), 'contributes.ui[0].component'), /\.\/path#Export/);
  assert.match(at(u({ attachTo: 'shell:x' }), 'contributes.ui[0]'), /component or a kit/);
  assert.match(at(u({ attachTo: 'shell:x', kit: {}, if: 1 }), 'contributes.ui[0].if'), /expression/);
  assert.match(at(u({ attachTo: 'shell:x', kit: {}, priority: 'high' }), 'contributes.ui[0].priority'), /number/);
  assert.match(at(u({ attachTo: 'shell:x', kit: { f: () => 1 } }), 'contributes.ui[0].kit'), /plain JSON/);
  assert.match(at(contrib({ ui: {} }), 'contributes.ui'), /list/);
  assert.match(at(contrib({ ui: [1] }), 'contributes.ui[0]'), /attachTo/);
});

test('parts, styles, blocks, recipes', () => {
  assert.match(at(contrib({ parts: ['other.badge'] }), 'contributes.parts[0]'), /prefix/);
  assert.match(at(contrib({ partStyles: { card: { color: 1 } } }), 'contributes.partStyles'), /property: value/);
  assert.match(at(contrib({ blocks: [{ kind: 'x' }] }), 'contributes.blocks'), /type, schema/);
  assert.match(at(contrib({ recipes: {} }), 'contributes.recipes'), /plain JSON/);
  assert.match(at(contrib({ icons: [1] }), 'contributes.icons[0]'), /non-empty/);
});
