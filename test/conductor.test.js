// A repo set up for Conductor (server/conductor.js): the strict TOML reader, which action runs, what
// refuses the file, and where Conductor stands against wisp's and Cursor's own files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, tmp } from './helpers.js';

process.env.WISP_HOME = tmp('conductor-home');
const { conductorEnv, conductorScripts, isConductorFile, parseToml } = await import('../server/conductor.js');
const { repoSetup, runCommand, runSetup, setupCommands, setupEnv } = await import('../server/worktree-setup.js');
const { setupItems } = await import('../server/project-trust.js');
const { taskPort } = await import('../server/runs.js');

const TOML = '.conductor/settings.toml';
// Maps to plain objects, opaque values to their text, so deepEqual can read them.
const plain = (v) => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? v.raw : v);
const parse = (text) => plain(parseToml(text));
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof text === 'string' ? text : JSON.stringify(text));
};
const scripts = (text) => {
  const dir = tmp('conductor');
  put(dir, TOML, text);
  return conductorScripts(dir);
};
const run = (text) => scripts(text).run;
const refused = (text, re) => {
  const c = scripts(text);
  assert.equal(c.setup, null);
  assert.equal(c.run, null);
  assert.ok(c.problem.startsWith(`couldn't read ${TOML}: `), c.problem);
  assert.match(c.problem, re);
};

const MAIN = `"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[git]
branch_prefix = "dev/"

[models]
default = "opus"

[environment_variables]
API_URL = "http://localhost:4000"

[scripts]
setup = """
#!/bin/bash
pnpm install
cp "$CONDUCTOR_ROOT_PATH/.env" .env
"""
archive = "rm -rf node_modules"
run_mode = "nonconcurrent"
auto_run_after_setup = true

[scripts.run.web]
command = "pnpm dev"
default = true
icon = "globe"

[scripts.run.api]
command = "pnpm api --port $((CONDUCTOR_PORT + 1))"
hide = false
available_in = ["local", "cloud"]
`;

test('parseToml: the docs’ main example, with $schema, a multi-line setup and several actions', () => {
  const d = parse(MAIN);
  assert.equal(d.$schema, 'https://conductor.build/schemas/settings.repo.schema.json');
  assert.equal(d.git.branch_prefix, 'dev/');
  assert.equal(d.scripts.setup, '#!/bin/bash\npnpm install\ncp "$CONDUCTOR_ROOT_PATH/.env" .env\n');
  assert.deepEqual(Object.keys(d.scripts.run), ['web', 'api']);
  assert.equal(d.scripts.run.api.command, 'pnpm api --port $((CONDUCTOR_PORT + 1))');
  assert.deepEqual(d.scripts.run.api.available_in, ['local', 'cloud']);
  const c = scripts(MAIN);
  assert.equal(c.file, TOML);
  assert.equal(c.setup, '#!/bin/bash\npnpm install\ncp "$CONDUCTOR_ROOT_PATH/.env" .env');
  assert.deepEqual(c.run, { command: 'pnpm dev' });
  assert.equal(c.problem, undefined);
  assert.ok(!JSON.stringify(c).includes('node_modules'), 'archive never appears');
});

test('the port-offset action, a legacy single action, [scripts.run.dev] with default', () => {
  assert.deepEqual(run('[scripts.run.api]\ncommand = "pnpm api --port $((CONDUCTOR_PORT + 1))"\n'), { command: 'pnpm api --port $((CONDUCTOR_PORT + 1))' });
  assert.deepEqual(run('[scripts]\nrun = "npm run dev"\n'), { command: 'npm run dev' });
  assert.deepEqual(run('[scripts.run.test]\ncommand = "npm test"\n\n[scripts.run.dev]\ncommand = "npm run dev"\ndefault = true\n'), { command: 'npm run dev' });
});

test('parseToml: CRLF, a BOM, literal strings, escapes, # inside strings', () => {
  assert.deepEqual(parse('\uFEFF[scripts]\r\nsetup = """\r\na\r\nb\r\n"""\r\nrun = "x" # c\r\n'), { scripts: { setup: 'a\nb\n', run: 'x' } });
  assert.deepEqual(parse(`a = 'C:\\n "x"'\nb = '''\nl\\n ' ''\n'''\n`), { a: 'C:\\n "x"', b: "l\\n ' ''\n" });
  assert.equal(parse(String.raw`a = "\b\t\n\f\r\"\\é\u00e9\U0001F600"`).a, '\b\t\n\f\r"\\éé😀');
  assert.deepEqual(parse('a = "# no" # yes\nb = \'# no\'\nc = """\n# no\n"""\n'), { a: '# no', b: '# no', c: '# no\n' });
  assert.equal(parse('a = """x \\\n   \n   y\\   \n z"""').a, 'x yz', 'a line-ending backslash');
  assert.equal(parse('a = """x"y""z"""""').a, 'x"y""z""', 'quotes before the closing three');
});

test('parseToml: a table or a key inside another key’s multi-line string isn’t read', () => {
  const text = `note = """
[scripts]
setup = "evil"
"""
lit = '''
[scripts]
setup = "evil"
'''
`;
  assert.deepEqual(Object.keys(parse(text)), ['note', 'lit']);
  assert.deepEqual(scripts(text), { file: TOML, setup: null, run: null });
  assert.equal(scripts(`${text}[scripts]\nsetup = "good"\n`).setup, 'good');
});

test('parseToml: dotted, quoted and bare keys, inline tables, multi-line arrays, arrays of tables, opaque values', () => {
  assert.deepEqual(parse('a.b.c = 1\na.b.d = 2\n"x.y".\'z\' = true\n1234 = false\n'), { a: { b: { c: '1', d: '2' } }, 'x.y': { z: true }, 1234: false });
  assert.deepEqual(parse('o = { cwd = "web", n = { a.b = 1 }, e = {} }'), { o: { cwd: 'web', n: { a: { b: '1' } }, e: {} } });
  assert.deepEqual(parse('a = [\n  "x", # one\n  # alone\n  ["y"],\n  { z = 1 },\n]\n'), { a: ['x', ['y'], { z: '1' }] });
  assert.deepEqual(parse('[[p]]\nn = 1\n[p.sub]\nk = 2\n[[p]]\nn = 3\n'), { p: [{ n: '1', sub: { k: '2' } }, { n: '3' }] });
  assert.deepEqual(parse('[a.b]\nc = 1\n[a]\nd = 2\n[fruit]\napple.color = "red"\n[fruit.apple.texture]\nsmooth = true\n'), { a: { b: { c: '1' }, d: '2' }, fruit: { apple: { color: 'red', texture: { smooth: true } } } });
  const d = parse('a = 1_000\nb = -0.5e3\nc = 0xFF\nd = 1979-05-27T07:32:00Z\ne = 1979-05-27 07:32:00\nf = 07:32:00\ng = 1979-05-27\nh = +inf\n');
  assert.deepEqual(d, { a: '1_000', b: '-0.5e3', c: '0xFF', d: '1979-05-27T07:32:00Z', e: '1979-05-27 07:32:00', f: '07:32:00', g: '1979-05-27', h: '+inf' });
  assert.deepEqual([...parseToml('[z]\n[a]\n[1]\n').keys()], ['z', 'a', '1'], 'file order, numeric keys too');
  assert.equal(parseToml('__proto__ = "x"').get('__proto__'), 'x');
});

test('parseToml: what it doesn’t know throws with the line', () => {
  for (const [text, re] of [
    ['a = 1\na = 2\n', /^line 2: duplicate key a/],
    ['[a]\n[a]\n', /^line 2: duplicate table a/],
    ['a = "x"\n[a]\n', /^line 2: a is both a value and a table/],
    ['a = "x"\n[a.b]\n', /^line 2: a is both/],
    ['[a.b]\n[a]\nb = 1\n', /^line 3: b is both/],
    ['a = { b = 1 }\n[a.c]\n', /^line 2: a is both/],
    ['a = [1]\n[[a]]\n', /^line 2: a is both/],
    ['[a]\nb.c = 1\n[a.b]\n', /^line 3: duplicate table b/],
    ['[a.b.c]\nz = 9\n[a]\nb.c.t = 1\n', /^line 4: c is both/],
    ['\n\na = "x\nb = 1\n', /^line 3: unterminated string/],
    ['a = 1\nb = """x\n\n', /^line 2: unterminated string/],
    ["a = '''x\n", /^line 1: unterminated string/],
    ['a = "\\q"\n', /^line 1: bad escape \\q/],
    ['\na = """\n\\e"""\n', /^line 3: bad escape/],
    ['a = "\\uD800"\n', /^line 1: bad \\u escape/],
    ['a = "\\u12"\n', /^line 1: bad \\u escape/],
    ['a = "x" b = 1\n', /^line 1: junk after the value/],
    ['a = 1 2\n', /^line 1: junk after the value/],
    ['a = truex\n', /^line 1: junk after the value/],
    ['a = 012\n', /^line 1: junk after the value/],
    ['ok = 1\nthis is junk\n', /^line 2: expected = after this/],
    ['a =\n', /^line 1: expected a value/],
    ['a = bare\n', /^line 1: expected a value/],
    ['[a\n', /^line 1: expected \] after the table name/],
    ['[[a]\n', /^line 1: expected \]\] after the table name/],
    ['a = [1 2]\n', /^line 1: expected , or \] in an array/],
    ['a = [1\n', /^line 2: expected a value|^line 2: expected , or \]/],
    ['a = { b = 1, }\n', /^line 1: expected a key/],
    ['a = { b = 1\n', /^line 1: expected , or }/],
    ['"""a""" = 1\n', /^line 1: a key can’t be a multi-line string/],
    ['a = "x\x01"\n', /^line 1: a control character/],
  ]) assert.throws(() => parseToml(text), (e) => re.test(e.message) || assert.fail(`${JSON.stringify(text)}: ${e.message}`));
});

test('a file that can’t be read for sure refuses all of it, setup too', () => {
  const setup = '[scripts]\nsetup = "npm ci"\n';
  refused(`${setup}run = "x"\nrun = "y"\n`, /line 4: duplicate key run/);
  refused(`${setup}run = "x"\n[scripts.run.web]\ncommand = "y"\n`, /line 4: run is both/);
  refused('[scripts]\nsetup = "npm ci\n', /line 2: unterminated string/);
  refused(`${setup}run = "\\q"\n`, /line 3: bad escape/);
  refused(`${setup}nonsense\n`, /line 3/);
  refused('[scripts]\nsetup = 5\n', /scripts\.setup must be a string/);
  refused('[scripts]\nsetup = ["a"]\n', /scripts\.setup must be a string/);
  refused('[scripts]\nsetup = 2020-01-01\n', /scripts\.setup must be a string/);
  refused('scripts = "x"\n', /scripts must be a table/);
  refused('scripts = 5\n', /scripts must be a table/);
  refused(`${setup}run = 5\n`, /scripts\.run must be/);
  refused(`${setup}[scripts.run]\nweb = "x"\n`, /scripts\.run\.web must be a table/);
  refused(`${setup}[scripts.run.web]\ncommand = 5\n`, /scripts\.run\.web\.command must be a string/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\nargs = "y"\n`, /args must be a list/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\nargs = [1]\n`, /args must be a list/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\nhide = "yes"\n`, /hide must be/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\ndefault = 1\n`, /default must be/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\navailable_in = 1\n`, /available_in must be/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\noptions = "y"\n`, /options must be a table/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\noptions.cwd = 1\n`, /cwd must be a string/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\noptions.cwd = "../x"\n`, /must stay inside the workspace/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\noptions.cwd = "a/../../x"\n`, /must stay inside the workspace/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\noptions.cwd = "/etc"\n`, /must stay inside the workspace/);
  refused(`${setup}[scripts.run.web]\ncommand = "x"\noptions.cwd = 'C:\\x'\n`, /must stay inside the workspace/);
});

test('conductor.json: setup and run, refused when it’s invalid or the wrong type, ignored once the toml exists', () => {
  const dir = tmp('conductor-json');
  assert.equal(conductorScripts(dir), null);
  put(dir, 'conductor.json', { scripts: { setup: ' npm ci\n', run: 'npm run dev', archive: 'rm -rf x' }, runScriptMode: 'concurrent' });
  assert.deepEqual(conductorScripts(dir), { file: 'conductor.json', setup: 'npm ci', run: { command: 'npm run dev' } });
  put(dir, 'conductor.json', `\uFEFF${JSON.stringify({ scripts: { setup: 'a' } })}`);
  assert.equal(conductorScripts(dir).setup, 'a');
  put(dir, 'conductor.json', { other: 1 });
  assert.deepEqual(conductorScripts(dir), { file: 'conductor.json', setup: null, run: null });
  put(dir, 'conductor.json', { scripts: { setup: '  ', run: '' } });
  assert.deepEqual(conductorScripts(dir), { file: 'conductor.json', setup: null, run: null }, 'empty is nothing');
  for (const [bad, re] of [
    ['{ nope', /^couldn't read conductor\.json: /],
    ['[]', /isn’t an object/],
    ['null', /isn’t an object/],
    [{ scripts: 'x' }, /scripts must be a table/],
    [{ scripts: [] }, /scripts must be a table/],
    [{ scripts: { setup: 1, run: 'x' } }, /scripts\.setup must be a string/],
    [{ scripts: { setup: 'a', run: { web: { command: 'x' } } } }, /scripts\.run must be/],
  ]) {
    put(dir, 'conductor.json', bad);
    const c = conductorScripts(dir);
    assert.deepEqual([c.setup, c.run], [null, null]);
    assert.match(c.problem, re);
  }
  // The toml wins, even with nothing in it, and when it can't be read.
  put(dir, 'conductor.json', { scripts: { setup: 'from json', run: 'json run' } });
  put(dir, TOML, 'x = 1\n');
  assert.deepEqual(conductorScripts(dir), { file: TOML, setup: null, run: null });
  put(dir, TOML, 'x = \n');
  assert.equal(conductorScripts(dir).file, TOML);
  assert.match(conductorScripts(dir).problem, /line 1/);
  assert.deepEqual(setupCommands(dir), []);
  fs.rmSync(path.join(dir, TOML));
  fs.mkdirSync(path.join(dir, TOML));
  assert.match(conductorScripts(dir).problem, /^couldn't read \.conductor\/settings\.toml: /, 'a read error that isn’t "no such file"');
});

test('which action: default, first, hide, cloud-only, no command, args, options.cwd', () => {
  const a = (id, body) => `[scripts.run.${id}]\n${body}\n`;
  assert.deepEqual(run(a('a', 'command = "a"') + a('b', 'command = "b"')), { command: 'a' }, 'the first');
  assert.deepEqual(run(a(9, 'command = "nine"') + a(1, 'command = "one"')), { command: 'nine' }, 'file order, numeric ids too');
  assert.deepEqual(run(a('a', 'command = "a"') + a('b', 'command = "b"\ndefault = true') + a('c', 'command = "c"\ndefault = true')), { command: 'b' }, 'the first default');
  assert.deepEqual(run(a('a', 'command = "a"\nhide = true\ndefault = true') + a('b', 'command = "b"')), { command: 'b' });
  assert.deepEqual(run(a('a', 'command = "a"\navailable_in = "cloud"\ndefault = true') + a('b', 'command = "b"\navailable_in = "local"')), { command: 'b' });
  assert.deepEqual(run(a('a', 'command = "a"\navailable_in = ["cloud"]') + a('b', 'command = "b"\navailable_in = ["cloud", "local"]')), { command: 'b' });
  assert.deepEqual(run(a('a', 'command = "a"\navailable_in = []') + a('b', 'icon = "x"\ndefault = true') + a('c', 'command = "  "') + a('d', 'command = "d"')), { command: 'd' });
  assert.equal(run(a('a', 'command = "a"\nhide = true') + a('b', 'default = true')), null, 'none can run');
  assert.equal(run('[scripts.run]\n'), null);
  const q = process.platform === 'win32' ? '"it\'s here" "" "$X"' : `'it'\\''s here' '' '$X'`;
  assert.deepEqual(run(a('a', `command = "pnpm dev"\nargs = ["--port=1", "a/b.c", "it's here", "", "$X"]`)), { command: `pnpm dev --port=1 a/b.c ${q}` });
  const cwd = path.join('apps', 'web');
  for (const o of ['options.cwd = "apps/web"', 'options = { cwd = "./apps/web" }', '[scripts.run.a.options]\ncwd = "apps/web"']) {
    assert.deepEqual(run(a('a', `command = "x"\n${o}`)), { command: 'x', cwd });
  }
  assert.deepEqual(run(a('a', 'command = "x"\noptions.cwd = "."')), { command: 'x' });
  assert.deepEqual(run(a('a', 'command = "x"\noptions.cwd = "a..b"')), { command: 'x', cwd: 'a..b' });
});

test('precedence: own beats Conductor per key, Cursor beats Conductor, an unreadable toml doesn’t fall to json or a guess', () => {
  const dir = tmp('conductor-order');
  put(dir, 'package.json', { scripts: { dev: 'vite' } });
  put(dir, TOML, '[scripts]\nsetup = "c setup"\nrun = "c run"\narchive = "c archive"\n');
  assert.deepEqual(repoSetup(dir), { file: TOML, commands: ['c setup'] });
  assert.deepEqual(runCommand(dir), { command: 'c run', port: null, source: 'conductor', file: TOML, cwd: dir }, 'ahead of package.json');

  // Own run, Conductor's setup: both apply. Own port stays with Conductor's run.
  put(dir, '.wisp/worktree.json', { run: 'own run', port: 5173 });
  assert.deepEqual(repoSetup(dir).commands, ['c setup']);
  assert.deepEqual(runCommand(dir), { command: 'own run', port: 5173, source: 'config' });
  put(dir, '.wisp/worktree.json', { port: 5173 });
  assert.equal(runCommand(dir).port, 5173);
  assert.equal(runCommand(dir).source, 'conductor');

  put(dir, '.cursor/worktrees.json', { 'setup-worktree': ['cursor'] });
  assert.deepEqual(repoSetup(dir), { file: '.cursor/worktrees.json', commands: ['cursor'] });
  put(dir, '.cursor/worktrees.json', { 'setup-worktree': [] });
  assert.deepEqual(repoSetup(dir), { file: '.cursor/worktrees.json', commands: [] }, 'a repo that says no setup keeps it');
  put(dir, '.wisp/worktree.json', { setup: 'own' });
  assert.deepEqual(repoSetup(dir), { file: '.wisp/worktree.json', commands: ['own'] });

  // Unreadable: own setup never looks at it; otherwise it says so, and nothing else stands in.
  put(dir, TOML, '[scripts\n');
  put(dir, 'conductor.json', { scripts: { setup: 'json', run: 'json run' } });
  assert.equal(repoSetup(dir).problem, undefined);
  fs.rmSync(path.join(dir, '.wisp'), { recursive: true });
  fs.rmSync(path.join(dir, '.cursor'), { recursive: true });
  const r = repoSetup(dir);
  assert.deepEqual(r.commands, []);
  assert.equal(r.file, TOML);
  assert.match(r.problem, /^couldn't read \.conductor\/settings\.toml: line 1/);
  assert.deepEqual(runCommand(dir), { command: null, port: null, source: 'conductor', file: TOML, problem: r.problem });

  // A Conductor file with no run leaves the guess.
  put(dir, TOML, '[scripts]\nsetup = "x"\n');
  assert.deepEqual(runCommand(dir), { command: 'npm run dev', port: null, source: 'package.json' });
});

test('runCommand: the file comes from the checkout, the action’s folder from it, own config from dir', () => {
  const top = tmp('conductor-top');
  const dir = path.join(top, 'packages', 'app');
  fs.mkdirSync(dir, { recursive: true });
  put(top, TOML, '[scripts.run.web]\ncommand = "x"\noptions.cwd = "apps/web"\n');
  assert.equal(runCommand(dir), null, 'without top there is nothing in that folder');
  assert.equal(runCommand(dir, top).cwd, path.join(top, 'apps', 'web'));
  put(dir, '.wisp/worktree.json', { run: 'own' });
  assert.equal(runCommand(dir, top).source, 'config');
});

test('setupItems and setupCommands agree for all four sources', () => {
  const dir = makeRepo();
  const agree = (file, command) => {
    assert.deepEqual(setupItems(dir).map((x) => [x.kind, x.file, x.name, x.command]), [['setup', file, 'step 1', command]]);
    assert.deepEqual(setupCommands(dir), [command]);
  };
  assert.deepEqual(setupItems(dir), []);
  put(dir, 'conductor.json', { scripts: { setup: 'json' } });
  agree('conductor.json', 'json');
  put(dir, TOML, '[scripts]\nsetup = """\nline one\nline two\n"""\n');
  agree(TOML, 'line one\nline two');
  put(dir, '.cursor/worktrees.json', { 'setup-worktree': 'cursor' });
  agree('.cursor/worktrees.json', 'cursor');
  put(dir, '.wisp/worktree.json', { setup: ['own'] });
  agree('.wisp/worktree.json', 'own');
  // Unreadable: nothing to list, nothing to run.
  fs.rmSync(path.join(dir, '.wisp'), { recursive: true });
  fs.rmSync(path.join(dir, '.cursor'), { recursive: true });
  put(dir, TOML, 'nope\n');
  assert.deepEqual(setupItems(dir), []);
  assert.deepEqual(setupCommands(dir), []);
});

test('a setup script that fails is named by its first line', async () => {
  const dir = tmp('conductor-fail');
  const { problems } = await runSetup(dir, dir, ['node missing-one.js\nnode missing-two.js']);
  assert.match(problems[0], /^setup `node missing-one\.js…` failed: /);
  assert.ok(!problems[0].startsWith('setup `node missing-one.js\n'));
});

test('conductorEnv, setupEnv, isConductorFile', () => {
  const dir = path.join('/w', 'repo-abc');
  assert.deepEqual(conductorEnv({ root: '/r', dir, branch: 'dev', port: 41005 }), {
    CONDUCTOR_ROOT_PATH: '/r',
    CONDUCTOR_WORKSPACE_PATH: dir,
    CONDUCTOR_WORKSPACE_NAME: 'repo-abc',
    CONDUCTOR_DEFAULT_BRANCH: 'dev',
    CONDUCTOR_PORT: '41005',
    CONDUCTOR_IS_LOCAL: '1',
  });
  assert.equal(conductorEnv({ root: '/r', dir, port: 1 }).CONDUCTOR_DEFAULT_BRANCH, 'main');
  assert.equal(conductorEnv({ root: '/r', dir, branch: '', port: 1 }).CONDUCTOR_DEFAULT_BRANCH, 'main');
  const env = setupEnv(TOML, { root: '/r', dir, branch: 'dev' });
  assert.equal(env.CONDUCTOR_PORT, String(taskPort('repo-abc')));
  assert.equal(setupEnv('conductor.json', { root: '/r', dir }).CONDUCTOR_WORKSPACE_NAME, 'repo-abc');
  for (const f of ['.wisp/worktree.json', '.cursor/worktrees.json', null, undefined]) assert.deepEqual(setupEnv(f, { root: '/r', dir }), {});
  assert.deepEqual([TOML, 'conductor.json', '.conductor/settings.local.toml', 'x/conductor.json'].map(isConductorFile), [true, true, false, false]);
});
