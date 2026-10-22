// Spells: validation, the store, the settings overlay, the API, hooks, agent blocks and a whole
// Cast a spell task through a real wisp server with the fake harnesses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const RECORD = tmp('spells-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('spells-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.WISP_RETRO_IDLE_MS = '600000';
process.env.FAKE_GH_STATE = path.join(tmp('spells-gh'), 'state.json');
installFakeBins();

const { normalizeSpell, describeSpell, overlayDefaults, Spells, scopeMatches } = await import('../server/spells.js');
const { SPELL_EXAMPLES, spellReference } = await import('../server/spell-guide.js');
const { systemPrompt, parsePresentation } = await import('../server/protocol.js');
const { blocksToMarkdown } = await import('../server/render.js');
const schema = await import('../web/js/spell-schema.js');
const { startServer } = await import('../server/index.js');

const problems = (raw) => {
  try {
    normalizeSpell(raw);
    return [];
  } catch (err) {
    return err.problems || [err.message];
  }
};
const base0 = { wispSpell: 1, id: 'x', name: 'X' };

// --- validation ------------------------------------------------------------------------------

test('every worked example in the agent reference is a valid spell', () => {
  for (const ex of SPELL_EXAMPLES) assert.deepEqual(problems(ex.spell), [], ex.ask);
  assert.ok(spellReference().slots.float);
});

test('normalizing is idempotent: a stored spell loads back the same', () => {
  const fnSpell = {
    ...base0, data: { s: { wisp: '/sessions' } }, script: 'export function n({ s }) { return s.length; }\nexport function links({ s }) { return []; }',
    buttons: [{ slot: 'float', label: 'N', badge: { fn: 'n', with: ['s'] }, do: { openAll: { fn: 'links', with: ['s'] } } }],
    chips: [{ slot: 'card.head', fn: 'n', with: ['s'] }],
  };
  for (const ex of [...SPELL_EXAMPLES, { ask: 'fn sources', spell: fnSpell }]) {
    const a = normalizeSpell(ex.spell).spell;
    assert.deepEqual(normalizeSpell(a).spell, a, ex.ask);
  }
});

test('spells are refused for what they may not do, with every problem listed', () => {
  const p = problems({
    wispSpell: 1,
    id: 'Bad Id',
    data: { m: { gh: ['pr', 'merge', '1'] }, a: { gh: ['api', 'repos/x', '-X', 'POST'] }, r: { wisp: '/remote' }, i: { wisp: '/internal/ask/1' } },
    parts: { card: { style: { background: 'url(https://evil.example/x.png)', color: 'red; display:none' } }, 'ask.question': { style: { color: 'red' } } },
    ui: { hide: ['approval'], tokens: { '--nope': '#fff' } },
    settings: { telemetry: 'off' },
    buttons: [{ slot: 'nowhere', label: 'x', do: { open: 'javascript:alert(1)' } }, { slot: 'topbar', label: 'y', do: { panel: 'missing' } }],
    blocks: [{ type: 'hero', doc: 'x', render: 'r' }],
    slash: [{ name: 'btw', do: { send: 'x' } }],
    hooks: [{ on: 'turn.finished', do: { exec: 'rm -rf /' } }],
    script: 'export function f( {',
  });
  const has = (re) => assert.ok(p.some((x) => re.test(x)), `expected a problem matching ${re}\n${p.join('\n')}`);
  has(/^id:/);
  has(/^name:/);
  has(/data\.m: gh pr merge isn't allowed/);
  has(/data\.a: gh api may only read/);
  has(/data\.r: \/remote isn't readable/);
  has(/data\.i: \/internal/);
  has(/parts\.card: background: value not allowed/);
  has(/parts\.card: color: value not allowed/);
  has(/parts\.ask\.question: not a part/);
  has(/ui\.hide: approval isn't a part/);
  has(/--nope isn't a token/);
  has(/settings\.telemetry: not a setting/);
  has(/buttons\[0\]: slot must be/);
  has(/buttons\[0\]: open needs an http\(s\) URL/);
  has(/buttons\[1\]: no panel named missing/);
  has(/blocks\[0\]: hero is a built-in block/);
  has(/slash\[0\]: \/btw is built in/);
  has(/hooks\[0\]: a hook can only/);
  has(/script: doesn't compile/);
});

test('split view: the view setting, sidebar and split slots, parts and pixel props', () => {
  const ok = {
    ...base0,
    settings: { view: 'split' },
    parts: { sidebar: { props: { width: 420, side: 'right', details: 'full' }, style: { background: '#fafafa' } }, 'split.main': { props: { readWidth: 1100 } }, 'split.home': { props: { greeting: 'Hi' } }, 'split.title': { style: { fontSize: '22px' } } },
    ui: { hide: ['sidebar.new', 'topbar.view'] },
    buttons: [
      { slot: 'sidebar.top', icon: 'github', do: { open: 'https://github.com/pulls' } },
      { slot: 'split.head', label: 'PR', when: { hasPr: true }, do: { open: '{pr.url}' } },
    ],
  };
  assert.deepEqual(problems(ok), []);
  assert.deepEqual(normalizeSpell(ok).spell.parts.sidebar.props, { width: 420, side: 'right', details: 'full' });
  assert.ok(schema.SLOTS['sidebar.top'] && schema.CARD_SLOTS.has('split.head'));
  assert.ok(spellReference().settings.view.includes('split'));
  const p = problems({ ...base0, settings: { view: 'grid' }, parts: { sidebar: { props: { width: 40, side: 'top' } }, 'split.main': { props: { readWidth: 5000 } } } });
  assert.ok(p.some((x) => /settings\.view/.test(x) && /feed \| split/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /width: px from 160 to 1600/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /readWidth: px from 160 to 1600/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /side: left \| right/.test(x)), p.join('\n'));
  // int props keep their 1–40 range
  assert.ok(problems({ ...base0, parts: { 'card.sub': { props: { lines: 41 } } } }).some((x) => /lines: int from 1 to 40/.test(x)));
});

test('take over in wisp: the terminal setting, its parts, font size and header slot', () => {
  const ok = {
    ...base0,
    settings: { terminal: 'wisp' },
    parts: { term: { props: { fontSize: 15 }, style: { borderRadius: '4px' } }, 'term.head': { style: { background: 'var(--bg-2)' } }, 'term.screen': { style: { padding: '4px' } } },
    ui: { hide: ['term.keys'] },
    buttons: [{ slot: 'term.head', icon: 'copy', label: 'Branch', do: { copy: '{branch}' } }],
  };
  assert.deepEqual(problems(ok), []);
  assert.ok(schema.CARD_SLOTS.has('term.head'));
  const p = problems({ ...base0, settings: { terminal: 'custom' }, parts: { term: { props: { fontSize: 99, height: 3 } } } });
  assert.ok(p.some((x) => /settings\.terminal/.test(x) && /wisp/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /fontSize: int from 1 to 40/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /height/.test(x)), p.join('\n'));
});

test('Settings → Cloud is parts spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, parts: { 'machines.cloud': { style: { borderRadius: '4px' } }, 'settings.cloud': { style: { borderRadius: '4px' } }, 'settings.cloud.computer': { style: { background: 'var(--surface)' } }, 'settings.connect': { style: { borderRadius: '4px' } }, 'getapp.card': { style: { borderRadius: '4px' } } }, ui: { hide: ['settings.cloud.signin', 'topbar.getapp'] } }), []);
  assert.ok(problems({ ...base0, parts: { 'settings.cloud': { props: { width: 400 } } } }).some((x) => /settings\.cloud/.test(x)));
});

test('Settings → Machines → This computer is a part spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['settings.nav'] }, parts: { settings: { style: { borderRadius: '4px' } }, 'settings.head': { style: { background: 'var(--bg-2)' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'settings.head': { props: { width: 400 } } } }).some((x) => /settings\.head/.test(x)));
  assert.deepEqual(problems({ ...base0, ui: { hide: ['settings.reachable', 'machines.howto'] }, parts: { 'settings.reachable': { style: { borderRadius: '4px' } }, 'machines.letin': { style: { background: 'var(--surface)' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'settings.reachable': { props: { width: 400 } } } }).some((x) => /settings\.reachable/.test(x)));
});

test('style values: no url(), imports, escapes or extra declarations; tokens and colours are fine', () => {
  assert.equal(schema.styleProblem('fontWeight', '650'), '');
  assert.equal(schema.styleProblem('background', 'var(--surface-2)'), '');
  assert.equal(schema.styleProblem('box-shadow', '0 1px 2px rgba(0,0,0,.2)'), '');
  for (const v of ['url(x)', 'image-set("a.png" 1x)', '@import "x"', 'red;color:blue', '\\75rl(x)', 'attr(data-x)', '}body{color:red']) assert.ok(schema.styleProblem('background', v), v);
  assert.ok(schema.styleProblem('position', 'fixed'), 'not an allowed property');
});

test('gh and wisp data allowlists', () => {
  assert.equal(schema.ghProblem(['search', 'prs', '--author', '@me']), '');
  assert.equal(schema.ghProblem(['pr', 'checks', '{pr.number}', '--json', 'name,state']), '');
  assert.equal(schema.ghProblem(['api', 'user']), '');
  assert.ok(schema.ghProblem(['api', 'graphql', '-f', 'query=mutation{}']));
  assert.ok(schema.ghProblem(['repo', 'delete', 'x']));
  assert.ok(schema.ghProblem(['auth', 'token']));
  assert.equal(schema.wispPathProblem('/usage/tools?days=7'), '');
  assert.equal(schema.wispPathProblem('/sessions/abc'), '');
  assert.ok(schema.wispPathProblem('/sessions/abc/exec'));
  assert.ok(schema.wispPathProblem('/config'));
});

test('templates, card filters and script exports', () => {
  assert.equal(schema.fillTemplate('PR #{pr.number} on {branch}{missing}', { pr: { number: 7 }, branch: 'wisp/x' }), 'PR #7 on wisp/x');
  assert.ok(schema.whenMatches({ hasPr: true, state: ['review', 'done'] }, { pr: { number: 1 }, state: 'review' }));
  assert.ok(!schema.whenMatches({ hasPr: true }, { pr: null }));
  assert.ok(!schema.whenMatches({ agent: 'codex' }, { agent: 'claude' }));
  assert.deepEqual(schema.scriptExports('export function a() {}\nexport async function b() {}\nexport const c = () => 1;\nfunction d() {}'), ['a', 'b', 'c']);
  const fns = new Function(schema.scriptBody('export function twice(x) { return x * 2; }\nexport const name = () => "n";'))();
  assert.equal(fns.twice(4), 8);
  assert.equal(fns.name(), 'n');
});

test('describeSpell says what a spell does and how risky it is', () => {
  const ex = (id) => normalizeSpell(SPELL_EXAMPLES.find((e) => e.spell.id === id).spell).spell;
  assert.equal(describeSpell(ex('tool-stats')).kind, 'safe');
  assert.equal(describeSpell(ex('my-prs')).kind, 'reads');
  assert.equal(describeSpell(ex('quick-replies')).kind, 'acts');
  assert.equal(describeSpell(ex('fix-failing-tests')).kind, 'acts');
  const ex2 = normalizeSpell({ ...base0, buttons: [{ slot: 'card.hover', label: 'Finder', do: { exec: 'open .' } }] }).spell;
  assert.equal(describeSpell(ex2).kind, 'runs');
  assert.match(describeSpell(ex('my-prs')).lines.join('\n'), /A floating button “My PRs” that opens every link in prs/);
  assert.match(describeSpell(ex('my-prs')).lines.join('\n'), /Reads GitHub: `gh search prs/);
});

test('scopes: project, harness and mode', () => {
  const project = { id: 'p1', name: 'api' };
  assert.ok(scopeMatches({ project: ['api'] }, { project, agent: 'claude' }));
  assert.ok(scopeMatches({ project: ['p1'], agent: ['claude'] }, { project, agent: 'claude' }));
  assert.ok(!scopeMatches({ agent: ['codex'] }, { project, agent: 'claude' }));
  assert.ok(scopeMatches({ project: ['/code/api'] }, { cwd: '/code/api/sub' }));
  assert.ok(!scopeMatches({ mode: ['plan'] }, { mode: 'auto' }));
});

test('a spell block that lost its closing brace (seen from Codex) is repaired, not skipped', () => {
  const raw = '```wisp\n{"blocks":[\n{"type":"hero","title":"t","summary":"s","status":"done"},\n{"type":"spell","spell":{"wispSpell":1,"id":"w","name":"W","script":"export function f() {\\n  return [];\\n}"}\n]}\n```';
  const p = parsePresentation(raw);
  assert.deepEqual(p.blocks.map((b) => b.type), ['hero', 'spell']);
  assert.equal(p.blocks[1].spell.id, 'w');
});

// --- the store and the overlay --------------------------------------------------------------

test('the store keeps spells off until turned on; a broken file is listed, not loaded', () => {
  const home = tmp('spells-store');
  const a = new Spells(home);
  a.install({ ...base0, settings: { mode: 'plan' } });
  assert.equal(a.isOn('x'), false);
  assert.deepEqual(a.settings().values, {});
  a.setEnabled('x', true);
  assert.deepEqual(a.settings().values, { mode: 'plan' });
  fs.writeFileSync(path.join(home, 'spells', 'junk.json'), '{"wispSpell":1,"id":"junk"}');
  const b = new Spells(home);
  assert.ok(b.isOn('x'), 'on/off survives a restart');
  assert.equal(b.list().broken[0].id, 'junk');
  assert.equal(new Spells(home, { safe: true }).enabled().length, 0, 'safe mode turns every spell off');
});

test('overlayDefaults: spell values win while on, and config.json keeps only yours', () => {
  const mine = { mode: 'auto', editor: 'zed' };
  let values = { mode: 'plan' };
  const d = overlayDefaults(mine, () => ({ values }));
  assert.equal(d.mode, 'plan');
  assert.equal(d.editor, 'zed');
  assert.deepEqual({ ...d }, { mode: 'plan', editor: 'zed' });
  assert.equal(JSON.stringify({ defaults: d }), '{"defaults":{"mode":"auto","editor":"zed"}}');
  d.editor = 'cursor';
  assert.equal(mine.editor, 'cursor', 'writes land on your settings');
  values = {};
  assert.equal(d.mode, 'auto', 'off: back to yours');
});

test('agent blocks from spells join the protocol; their summary stands in for them as text', () => {
  const p = systemPrompt({ extraBlocks: [{ type: 'deploy', doc: '{"type":"deploy","env":"x"} After you deploy.', spell: 'Deploy block' }] });
  assert.match(p, /- \{"type":"deploy","env":"x"\}\n {2}After you deploy\.\n {2}\(From the user's spell Deploy block\.\)\n\nStrings must be valid JSON/);
  assert.equal(systemPrompt(), systemPrompt({ extraBlocks: [] }));
  assert.match(blocksToMarkdown([{ type: 'spell', spell: { name: 'My PRs', description: 'Opens PRs' } }]), /🧙 Spell: My PRs\*\* — Opens PRs/);
  assert.match(blocksToMarkdown([{ type: 'spell', spell: { type: 'spell', remove: 'my-prs' } }]), /remove `my-prs`/, 'a removal nested the way agents write it');
});

// --- through a real server ------------------------------------------------------------------

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function call(method, p, body) {
  const write = method !== 'GET';
  const r = await fetch(`${base}/api${p}`, { method, headers: write ? { 'content-type': 'application/json' } : {}, body: write ? JSON.stringify(body || {}) : undefined });
  return { status: r.status, body: await r.json() };
}
const ok = async (method, p, body) => {
  const r = await call(method, p, body);
  assert.ok(r.status < 300, `${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const done = (id) => until(async () => (await ok('GET', `/sessions/${id}`)).turns.at(-1)?.status === 'done' && (await ok('GET', `/sessions/${id}`)), { timeout: 30_000 });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('install → off; enable → its settings win and lock; off → yours are back, config.json never had them', async () => {
  const spell = { wispSpell: 1, id: 'plan-first', name: 'Plan first', settings: { mode: 'plan', transcript: 'on' }, recipes: [{ name: 'Triage', prompt: 'Triage {label}' }] };
  const check = await ok('POST', '/spells/check', { spell });
  assert.equal(check.ok, true);
  assert.equal(check.kind, 'safe');
  assert.equal((await call('POST', '/spells', { spell })).status, 201);
  assert.equal((await ok('GET', '/config')).defaults.mode, 'auto', 'installed, not on');

  await ok('PATCH', '/spells/plan-first', { enabled: true });
  const cfg = await ok('GET', '/config');
  assert.equal(cfg.defaults.mode, 'plan');
  assert.deepEqual(cfg.lockedBy.mode, { id: 'plan-first', name: 'Plan first' });
  assert.ok(cfg.spells.some((s) => s.id === 'plan-first'));
  assert.ok(cfg.recipes.some((r) => r.name === 'Triage' && r.spell?.id === 'plan-first'));
  const locked = await call('PATCH', '/config', { defaults: { mode: 'auto' } });
  assert.equal(locked.status, 409);
  await ok('PATCH', '/config', { defaults: { mode: 'plan', editor: 'zed' } }); // same value + another key: fine
  assert.equal((await call('PATCH', `/recipes/${cfg.recipes.find((r) => r.spell).id}`, { name: 'Mine now' })).status, 409);

  await ok('PATCH', '/spells/plan-first', { enabled: false });
  const after = await ok('GET', '/config');
  assert.equal(after.defaults.mode, 'auto');
  assert.equal(after.defaults.editor, 'zed');
  assert.ok(!after.recipes.some((r) => r.spell));
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8'));
  assert.equal(saved.defaults.mode, 'auto');
  assert.equal(saved.defaults.transcript, undefined);
});

test('check reports problems without installing; export is the spell file; remove deletes it', async () => {
  const bad = await ok('POST', '/spells/check', { text: JSON.stringify({ wispSpell: 1, id: 'bad', name: 'Bad', ui: { hide: ['nope'] } }) });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /nope isn't a part/);
  assert.equal((await call('POST', '/spells', { spell: { wispSpell: 1, id: 'bad' } })).status, 400);
  assert.equal((await call('POST', '/spells/check', { text: '{nope' })).status, 400);

  await ok('POST', '/spells', { text: JSON.stringify({ wispSpell: 1, id: 'shared', name: 'Shared', prompt: ['Be brief.'] }), name: 'shared.spell.json' });
  const listed = (await ok('GET', '/spells')).spells.find((s) => s.id === 'shared');
  assert.equal(listed.enabled, false);
  assert.equal(listed.source.kind, 'file');
  const exported = await ok('GET', '/spells/shared/export');
  assert.deepEqual(Object.keys(exported).sort(), ['harnesses', 'id', 'name', 'prompt', 'version', 'wispSpell', 'author', 'description'].sort());
  await ok('DELETE', '/spells/shared');
  assert.equal((await call('GET', '/spells/shared')).status, 404);
});

test('two spells that claim the same block type or slash command can not both be on', async () => {
  const mk = (id) => ({ wispSpell: 1, id, name: id, blocks: [{ type: 'deploy', doc: '{"type":"deploy"}', render: 'r' }], script: 'export function r(b) { return []; }' });
  await ok('POST', '/spells', { spell: mk('one'), enable: true });
  await ok('POST', '/spells', { spell: mk('two') });
  const r = await call('PATCH', '/spells/two', { enabled: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /block type deploy is already one's/);
  await ok('POST', '/spells/off', {});
  assert.equal((await ok('GET', '/spells')).spells.filter((s) => s.enabled).length, 0);
  await ok('DELETE', '/spells/one');
  await ok('DELETE', '/spells/two');
});

test('data sources: wisp GETs and read-only gh, fetched for the spell; /open takes only http(s)', async () => {
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ runs: [{ databaseId: 1, name: 'CI', conclusion: 'failure', url: 'https://github.com/acme/repo/actions/runs/1', headBranch: 'main' }] }));
  await ok('POST', '/spells', {
    spell: { wispSpell: 1, id: 'data', name: 'Data', data: { tools: { wisp: '/usage/tools?days=7' }, runs: { gh: ['run', 'list', '--json', 'url,name'] } } },
    enable: true,
  });
  const tools = await ok('POST', '/spells/data/data/tools', {});
  assert.equal(typeof tools.value.total.calls, 'number');
  assert.ok(Array.isArray(tools.value.kinds));
  const runs = await ok('POST', '/spells/data/data/runs', {});
  assert.ok(Array.isArray(runs.value));
  assert.ok(records(RECORD, 'gh').some((r) => r.argv[0] === 'run' && r.argv[1] === 'list'));
  assert.equal((await call('POST', '/spells/data/data/nope', {})).status, 404);
  assert.deepEqual((await ok('POST', '/open', { urls: ['https://github.com/a', 'file:///etc/passwd', 'javascript:x'] })).opened, ['https://github.com/a']);
  assert.equal((await call('POST', '/open', { urls: ['file:///etc/passwd'] })).status, 400);
  await ok('DELETE', '/spells/data');
});

test('prompt rules and agent blocks reach the agent; a spell-only harness filter keeps them off others', async () => {
  const cwd = makeRepo();
  await ok('POST', '/spells', {
    spell: {
      wispSpell: 1, id: 'rules', name: 'Rules', prompt: ['Run the linter before you report.', { text: 'Codex only rule.', when: { agent: 'codex' } }],
      blocks: [{ type: 'deploy', doc: '{"type":"deploy","env":"staging","url":"https://…"} After a deploy.', summary: 'Deployed {env} → {url}', render: 'deploy' }],
      script: 'export function deploy(b) { return [{ type: "callout", tone: "success", title: b.env, text: b.url }]; }',
    },
    enable: true,
  });
  const s = await ok('POST', '/sessions', { prompt: 'fix the bug DEPLOYBLOCK', cwd, agent: 'claude', mode: 'auto', worktree: false });
  const full = await done(s.id);
  const argv = records(RECORD, 'claude').findLast((r) => r.stdin.includes('DEPLOYBLOCK')).argv;
  const sys = argv[argv.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## Spells the user cast[\s\S]*Run the linter before you report\. _\(spell: Rules\)_/);
  assert.doesNotMatch(sys, /Codex only rule/);
  assert.match(sys, /\{"type":"deploy","env":"staging"/);
  assert.ok(full.turns.at(-1).presentation.blocks.some((b) => b.type === 'deploy'));
  const md = await ok('GET', `/sessions/${s.id}/presentation`);
  assert.match(md.markdown, /Deployed staging → https:\/\/staging\.example\.com/);
  await ok('DELETE', '/spells/rules');
});

test('a hook sends a task with failing tests back once, then stops', async () => {
  const cwd = makeRepo();
  await ok('POST', '/spells', { spell: SPELL_EXAMPLES.find((e) => e.spell.id === 'fix-failing-tests').spell, enable: true });
  const s = await ok('POST', '/sessions', { prompt: 'fix it FAILTESTS', cwd, agent: 'claude', mode: 'auto', worktree: false });
  const full = await until(async () => {
    const x = await ok('GET', `/sessions/${s.id}`);
    return x.turns.length === 2 && x.turns[1].status === 'done' && x;
  }, { timeout: 30_000 });
  assert.match(full.turns[1].prompt, /Some tests fail\. Fix them/);
  assert.equal(full.turns[1].by, 'wisp');
  // A third turn never comes: max 1 per task, and the follow-up's report passed anyway.
  await ok('POST', `/sessions/${s.id}/reply`, { text: 'again FAILTESTS' });
  await until(async () => (await ok('GET', `/sessions/${s.id}`)).turns[2]?.status === 'done', { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await ok('GET', `/sessions/${s.id}`)).turns.length, 3);
  await ok('DELETE', '/spells/fix-failing-tests');
});

test('Cast a spell: a folder-less task whose agent gets the spell tools and hands back a spell block', async () => {
  const s = await ok('POST', '/sessions', { prompt: 'CAST add a hello rule', kind: 'spell', agent: 'claude', cwd: makeRepo() });
  assert.equal(s.kind, 'spell');
  assert.match(s.title, /^Spell: /);
  const full = await done(s.id);
  assert.equal(full.mode, 'edits'); // Claude's Plan mode refuses MCP tools
  assert.ok(full.cwd.includes(`${path.sep}scratch${path.sep}`), 'runs in a scratch folder, not the project');
  const rec = records(RECORD, 'claude').findLast((r) => r.stdin.includes('CAST'));
  const sys = rec.argv[rec.argv.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## This task: cast a spell on wisp/);
  const mcp = JSON.parse(rec.argv[rec.argv.indexOf('--mcp-config') + 1]);
  assert.equal(mcp.mcpServers.wisp.env.WISP_SPELLS, '1');
  const hero = full.turns.at(-1).presentation.blocks[0];
  assert.match(hero.summary, /schema read \| check: ok — “Fake hello” \(safe\) would:/);
  const block = full.turns.at(-1).presentation.blocks.find((b) => b.type === 'spell');
  assert.equal(block.spell.id, 'fake-hello');
  assert.equal((await call('GET', '/spells/fake-hello')).status, 404, 'nothing is installed until the user keeps it');
});

test('the spell tools only answer a Cast a spell task with the right token', async () => {
  const cwd = makeRepo();
  const s = await ok('POST', '/sessions', { prompt: 'plain task', cwd, agent: 'claude', worktree: false });
  await done(s.id);
  const r = await fetch(`${base}/api/internal/spell-schema/${s.id}`, { headers: { 'x-wisp-token': srv.runner.bridge.token } });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/api/internal/spell-schema/${s.id}`, { headers: { 'x-wisp-token': 'nope' } });
  assert.equal(r2.status, 403);
});
