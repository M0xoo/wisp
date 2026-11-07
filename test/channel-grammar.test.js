// The message grammar, as a table: what a message says, and just as much what it must not be read
// as. Pure: no server, no agents. Must-fixes from the review are named where they're tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProject, parseMessage, stripFormatting } from '../server/channels/grammar.js';
import claudeAdapter from '../server/adapters/claude.js';
import { ackCrew, ackTask, crew as crewList, example, help, machines as machineList, modelLabel, modelNote, models, projects as projectList, ranInstead, refusal, status } from '../server/channels/lists.js';

const claude = { id: 'claude', name: 'Claude Code', available: true, models: [{ id: '', label: 'Default' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const codexThere = { id: 'codex', name: 'Codex', available: true, models: [{ id: '', label: 'Default' }, { id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'] }, { id: 'gpt-5-mini', label: 'GPT-5 mini' }], efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const cursor = { id: 'cursor-agent', name: 'Cursor', available: true, models: [{ id: '', label: 'Default' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus-max', label: 'Opus Max' }], efforts: [] };
const opencode = { id: 'opencode', name: 'OpenCode', available: false, signedIn: false, models: [{ id: 'anthropic/claude-sonnet', label: 'Claude Sonnet' }], efforts: [] };
const adapters = [claude, { ...codexThere, available: undefined, models: [{ id: '', label: 'Default' }] }, cursor, opencode, { id: 'wisp', name: 'wisp', models: [] }];

const projects = [
  { id: 'p1', name: 'api', path: '/code/api' },
  { id: 'p2', name: 'api-gateway', path: '/code/gateway' },
  { id: 'p3', name: 'web', path: '/Applications/web' },
  { id: 'p4', name: 'mobile app', path: '/code/mobile' },
  { id: 'p5', name: 'ops', path: '/srv/ops', machine: 'm-lap' },
  { id: 'p6', name: 'dark', path: '/srv/dark', machine: 'm-off' },
];
const machines = [
  { id: 'm-lap', name: 'laptop', usable: true, agents: [claude] },
  { id: 'm-mini', name: 'mac mini', usable: true, agents: [claude, codexThere] },
  { id: 'm-mid', name: 'mid', usable: true, agents: [{ ...claude, available: false }] },
  { id: 'm-off', name: 'desktop', usable: false, agents: null },
  { id: 'm-cloud', name: 'my cloud', kind: 'grid', usable: true, agents: null },
];
const ada = { id: 'adaaaa', name: 'Ada', agent: 'claude', model: 'sonnet', mode: 'edits', cwd: '/code/api', machine: '' };
const bo = { id: 'boooob', name: 'Bo', agent: 'codex', model: '', mode: 'plan', cwd: '/code/gateway', machine: 'm-mini' };
const mo = { id: 'moooom', name: 'Mo Auto', agent: 'auto', model: '', mode: 'auto', cwd: '', machine: '' };
const dot = { id: 'dottie', name: 'Dot', agent: 'claude', model: '', mode: 'plan', cwd: '/srv/dark', machine: 'm-off' };
const sam = { id: 'sammmm', name: 'Sam', agent: 'claude', model: '', mode: 'plan', cwd: '', machine: '', sandbox: 'job' };
const ctx = { projects, machines, agents: [claude, cursor, opencode], adapters, crew: [ada, bo, mo, dot, sam], goals: ['cheap', 'balanced', 'best'], defaultProject: projects[0], defaultAgent: 'claude', sandbox: true };

// [message, what must hold]; a key left out is unchecked, except that nothing is refused unless
// `no` says how, and `same` means the whole message stays the prompt with no options read.
const NO_OPTIONS = { crew: null, project: null, machine: null, agent: null, model: null, effort: null, mode: null };
const TABLE = [
  // The promise.
  ['@ada in api on here with opus high plan: fix the flaky login test', { crew: 'Ada', project: 'api', machine: '', model: 'opus', effort: 'high', mode: 'plan', prompt: 'fix the flaky login test' }],
  ['in api on laptop with opus high plan: fix the flaky login test', { project: 'api', machine: 'm-lap', agent: 'claude', model: 'opus', effort: 'high', mode: 'plan', prompt: 'fix the flaky login test' }],
  ['fix the flaky login test', { same: true }],
  ['#web plan: fix the header', { project: 'web', mode: 'plan', prompt: 'fix the header' }],
  ['#web fix the header', { project: 'web', mode: null, prompt: 'fix the header' }],
  ['in web fix the header', { project: 'web', prompt: 'fix the header' }],
  ['on laptop fix the header', { machine: 'm-lap', prompt: 'fix the header' }],
  ['with sonnet fix the header', { agent: 'claude', model: 'sonnet', prompt: 'fix the header' }],
  ['with claude sonnet high: fix it', { agent: 'claude', model: 'sonnet', effort: 'high', prompt: 'fix it' }],
  ['with opus, fix it', { model: 'opus', prompt: 'fix it' }],
  ['edits: tidy the readme', { mode: 'edits', prompt: 'tidy the readme' }],
  ['Plan: tidy the readme', { mode: 'plan', prompt: 'tidy the readme' }],
  ['PLAN : tidy the readme', { mode: 'plan', prompt: 'tidy the readme' }],
  ['in api: fix it', { project: 'api', prompt: 'fix it' }],
  ['on laptop: fix it', { machine: 'm-lap', prompt: 'fix it' }],
  ['in mobile app fix the menu', { project: 'mobile app', prompt: 'fix the menu' }],
  ['on mac mini with gpt-5 high fix it', { machine: 'm-mini', agent: 'codex', model: 'gpt-5', effort: 'high', prompt: 'fix it' }],
  ['/new in api fix it', { command: 'new', project: 'api', prompt: 'fix it' }],
  ['/new @web fix it', { command: 'new', project: 'web', prompt: 'fix it' }],
  ['/new fix it', { command: 'new', prompt: 'fix it' }],
  ['@web fix it', { project: 'web', prompt: 'fix it' }],

  // Must-fix 1: plan and edits as a first word.
  ['plan the migration to postgres', { same: true }],
  ['edits to the readme look wrong, fix them', { same: true }],
  ['#api plan the migration', { project: 'api', mode: 'plan', prompt: 'the migration' }],
  ['with opus edits the readme', { model: 'opus', mode: 'edits', prompt: 'the readme' }],
  ['planning the migration is next', { same: true }],

  // Must-fix 2: bare in/on: exact name or unique prefix, never a substring of a name or path.
  ['in app, the button is wrong', { same: true, note: /“in app”/ }],
  ['in applications the icon is off', { same: true, note: /“in applications”/ }],
  ['in gateway fix it', { same: true, note: /“in gateway”/ }],
  ['in mob fix it', { project: 'mobile app', prompt: 'fix it' }],
  ['in web fix it', { project: 'web', prompt: 'fix it' }],
  ['#gateway fix it', { project: 'api-gateway', prompt: 'fix it' }],
  ['#appl fix it', { project: 'web', prompt: 'fix it' }],
  ['@gateway fix it', { project: 'api-gateway', prompt: 'fix it' }],
  ['in a minute restart the server', { same: true, note: /“in a”/ }],
  ['on the login page the button is wrong', { same: true, note: /“on the”/ }],
  ['on my phone the header overlaps', { same: true, note: /“on my”/ }],
  ['in ap fix it', { no: 'ambiguous', choices: ['api', 'api-gateway'] }],
  ['in api fix it', { project: 'api', prompt: 'fix it' }],
  ['in api-g fix it', { project: 'api-gateway', prompt: 'fix it' }],

  // Must-fix 3: an unmatched in/on.
  ['on nothere: fix it', { no: 'no-match', choices: ['laptop', 'mac mini', 'mid', 'desktop', 'my cloud'] }],
  ['in nothere: fix it', { no: 'no-match', choices: projects.map((p) => p.name) }],
  ['on nothere with opus: fix it', { no: 'no-match' }],
  ['on nothere plan: fix it', { no: 'no-match' }],
  ['on nothere fix it', { same: true, note: /“on nothere” isn’t one of your machines/ }],
  ['in nothere fix it: now', { same: true, note: /“in nothere” isn’t one of your projects/ }],
  [': on nothere: fix it', { ...NO_OPTIONS, prompt: 'on nothere: fix it' }],
  [': plan the migration', { ...NO_OPTIONS, prompt: 'plan the migration' }],
  [':in api fix it', { ...NO_OPTIONS, prompt: 'in api fix it' }],
  ['：@ada fix it', { ...NO_OPTIONS, prompt: '@ada fix it' }],
  [': help', { ...NO_OPTIONS, command: null, prompt: 'help' }],

  // Must-fix 4: with X, known somewhere or not at all.
  ['with care fix it', { same: true }],
  ['with a test for login, fix it', { same: true }],
  ['with high priority fix the login', { same: true }],
  ['with gpt-5 fix it', { no: 'not-installed' }],
  ['with gpt-9 fix it', { no: 'not-installed' }],
  ['with codex fix it', { no: 'not-installed', choices: ['Claude Code', 'Cursor'] }],
  ['with opencode fix it', { no: 'not-installed', text: /isn’t signed in/ }],
  ['on laptop with gpt-5 fix it', { no: 'not-installed' }],
  ['on laptop with cursor fix it', { no: 'not-installed' }],
  ['on mid with claude fix it', { no: 'not-installed', text: /on mid/ }],
  ['on mac with codex fix it', { machine: 'm-mini', agent: 'codex', prompt: 'fix it' }],
  ['on mini with codex fix it', { note: /“on mini”/, prompt: 'on mini with codex fix it' }], // a prefix, not any word of a name
  ['with opus-max fix it', { agent: 'cursor-agent', model: 'opus-max', prompt: 'fix it' }],
  ['with son fix it', { agent: 'claude', model: 'sonnet', prompt: 'fix it' }], // on two harnesses: the default one's
  ['with sonnet fix it', { agent: 'claude', model: 'sonnet', prompt: 'fix it' }],
  ['with cursor sonnet fix it', { agent: 'cursor-agent', model: 'sonnet', prompt: 'fix it' }],
  ['with Opus Max fix it', { model: 'opus', effort: 'max', prompt: 'fix it' }],
  ['with opus ultra fix it', { model: 'opus', prompt: 'ultra fix it' }],
  ['with cursor sonnet high fix it', { no: 'not-installed', text: /thinking level/ }],
  ['with opus minimal fix it', { no: 'not-installed', choices: claude.efforts }],
  ['with high: fix it', { effort: 'high', prompt: 'fix it' }],

  // Must-fix 5: full auto is a word, under the same rule as plan and edits.
  ['full auto: fix it', { mode: 'auto', prompt: 'fix it' }],
  ['#api full auto fix it', { project: 'api', mode: 'auto', prompt: 'fix it' }],
  ['with opus full auto: fix it', { mode: 'auto', prompt: 'fix it' }],
  ['full auto mode is broken, fix it', { same: true }],

  // Must-fix 8: commands, notes, Auto's goal in model.
  ['with auto fix it', { agent: 'auto', model: null, prompt: 'fix it' }],
  ['with auto cheap fix it', { agent: 'auto', model: 'cheap', prompt: 'fix it' }],
  ['with auto best: fix it', { agent: 'auto', model: 'best', prompt: 'fix it' }],
  ['with auto high fix it', { no: 'refused', choices: ['cheap', 'balanced', 'best'] }],
  ['on laptop with auto cheap fix it', { machine: 'm-lap', agent: 'auto', model: 'cheap', prompt: 'fix it' }],
  ['help', { command: 'help', prompt: '' }],
  ['Help?', { command: 'help', prompt: '' }],
  ['/help', { command: 'help' }],
  ['/start', { command: 'help' }],
  ['projects', { command: 'projects' }],
  ['/projects', { command: 'projects' }],
  ['models', { command: 'models' }],
  ['models on laptop', { command: 'models', arg: 'laptop' }],
  ['models laptop', { command: 'models', arg: 'laptop' }],
  ['/models mac mini', { command: 'models', arg: 'mac mini' }],
  ['crew', { command: 'crew' }],
  ['machines', { command: 'machines' }],
  ['status', { command: 'status' }],
  ['stop', { command: 'stop' }],
  ['done', { command: 'done' }],
  ['/bogus', { no: 'unknown' }],
  ['help me fix the login', { same: true }],
  ['models are slow, fix the cache', { same: true }],
  ['status page is down', { same: true }],
  ['stop the deploy script from crashing', { same: true }],

  // Offline: never "not installed".
  ['on desktop fix it', { no: 'offline', choices: ['laptop', 'mac mini', 'mid', 'my cloud'] }],
  ['on desktop with opus fix it', { no: 'offline', text: /^desktop is offline/ }],
  ['in dark fix it', { no: 'offline' }],
  ['on my cloud with opus fix it', { machine: 'm-cloud', agent: 'claude', model: 'opus', prompt: 'fix it' }], // asleep: it wakes
  ['on cloud fix it', { machine: 'm-cloud', prompt: 'fix it' }],
  ['on sandbox fix it', { machine: 'sandbox', prompt: 'fix it' }],
  ['on here fix it', { machine: '', prompt: 'fix it' }],
  ['on this computer fix it', { machine: '', prompt: 'fix it' }],
  ['in ops with sonnet fix it', { project: 'ops', model: 'sonnet', prompt: 'fix it' }],
  ['in ops with gpt-5 fix it', { no: 'not-installed', text: /on laptop/ }],

  // Crew.
  ['@ada fix it', { crew: 'Ada', prompt: 'fix it' }],
  ['@Ada: fix it', { crew: 'Ada', prompt: 'fix it' }],
  ['@mo-auto fix it', { crew: 'Mo Auto', prompt: 'fix it' }],
  ['@Mo Auto fix it', { crew: 'Mo Auto', prompt: 'fix it' }],
  ['@ada @bo fix it', { crew: 'Ada', tagged: ['Bo'], prompt: 'fix it' }],
  ['@ada fix it with @bo', { crew: 'Ada', tagged: ['Bo'], prompt: 'fix it with @bo' }],
  ['fix it with @bo', { crew: null, tagged: ['Bo'], prompt: 'fix it with @bo' }],
  ['@nobody fix it', { no: 'no-match', text: /“nobody”/ }],
  ['#nowhere fix it', { no: 'no-match', text: /“nowhere”/ }],
  ['@types/node needs upgrading', { same: true }],
  ['#123 is broken, fix it', { same: true }],
  ['@ada plan: look at it', { crew: 'Ada', mode: 'plan', prompt: 'look at it' }],
  ['@ada with opus high: look at it', { crew: 'Ada', agent: null, model: 'opus', effort: 'high', prompt: 'look at it' }],
  ['@ada with claude opus: look at it', { crew: 'Ada', agent: null, model: 'opus', prompt: 'look at it' }],
  // Must-fix 9: harness refused, Auto refused, in/on only their own.
  ['@ada with codex look at it', { no: 'refused', text: /can’t change harness/ }],
  ['@ada with auto look at it', { no: 'refused', text: /can’t change harness/ }],
  ['@ada with gpt-5 look at it', { no: 'not-installed' }],
  ['@mo-auto with opus look at it', { no: 'refused', text: /on Auto/ }],
  ['@mo-auto plan: look at it', { crew: 'Mo Auto', mode: 'plan', prompt: 'look at it' }],
  ['@ada in web look at it', { no: 'refused', text: /can’t move them to web/ }],
  ['@ada in api look at it', { crew: 'Ada', project: 'api', prompt: 'look at it' }],
  ['@ada on laptop look at it', { no: 'refused', text: /can’t move them to laptop/ }],
  ['@ada on here look at it', { crew: 'Ada', machine: '', prompt: 'look at it' }],
  ['@bo on mac look at it', { crew: 'Bo', machine: 'm-mini', prompt: 'look at it' }],
  ['@bo with gpt-5 high: look at it', { crew: 'Bo', model: 'gpt-5', effort: 'high', prompt: 'look at it' }],
  ['@dot with opus look at it', { no: 'offline' }],
  ['@sam on sandbox with opus: look at it', { crew: 'Sam', machine: 'sandbox', model: 'opus', prompt: 'look at it' }],

  // Telegram formatting around the options; the prompt stays as written.
  ['**in api** fix it', { same: false, project: 'api', prompt: 'fix it' }],
  ['*plan*: fix it', { mode: 'plan', prompt: 'fix it' }],
  ['**plan:** fix it', { mode: 'plan', prompt: 'fix it' }],
  ['`#api` fix it', { project: 'api', prompt: 'fix it' }],
  ['_@ada_ fix it', { crew: 'Ada', prompt: 'fix it' }],
  ['#api fix `__init__.py` and **bold**', { project: 'api', prompt: 'fix `__init__.py` and **bold**' }],
  ['in api：fix it', { project: 'api', prompt: 'in api：fix it'.slice(7) }],
  ['#api\nfix it\non two lines', { project: 'api', prompt: 'fix it\non two lines' }],
  ['with opus\nplan: fix it', { model: 'opus', mode: 'plan', prompt: 'fix it' }],
  ['', { prompt: '', ...NO_OPTIONS }],
  ['   ', { prompt: '' }],
];

const by = (x) => (x?.name ?? x);
for (const [text, want] of TABLE) {
  test(`parseMessage: ${JSON.stringify(text)}`, () => {
    const p = parseMessage(text, ctx);
    if (want.no) {
      assert.ok(p.problems.length, `should be refused, read as ${JSON.stringify(p.prompt)}`);
      assert.equal(p.problems[0].kind, want.no, p.problems[0].text);
      if (want.text) assert.match(p.problems[0].text, want.text);
      if (want.choices) assert.deepEqual(p.problems[0].choices, want.choices);
      return;
    }
    assert.deepEqual(p.problems, []);
    if (want.same) {
      assert.equal(p.prompt, text);
      for (const k of ['crew', 'project', 'machine', 'agent', 'model', 'effort', 'mode']) assert.equal(p[k], null, k);
    }
    if (want.note) assert.match(p.notes.join('\n'), want.note);
    else assert.deepEqual(p.notes, []);
    for (const [k, v] of Object.entries(want)) {
      if (['same', 'note', 'tagged'].includes(k)) continue;
      assert.deepEqual(by(p[k]), v, k);
    }
    if (want.tagged) assert.deepEqual(p.tagged.map((m) => m.name), want.tagged);
  });
}

test('the table is big enough, and a message only refused says why', () => {
  assert.ok(TABLE.length >= 60, `${TABLE.length} messages`);
  assert.ok(TABLE.filter(([, w]) => w.same).length >= 15, 'sentences that must not parse as options');
});

test('every option reads the same in any order', () => {
  const a = parseMessage('with opus in api plan: x', ctx);
  const b = parseMessage('in api plan with opus: x', ctx);
  for (const p of [a, b]) assert.deepEqual([p.project.name, p.model, p.mode, p.prompt], ['api', 'opus', 'plan', 'x']);
});

test('the machine decides the model, wherever "on" stands', () => {
  assert.equal(parseMessage('with gpt-5 on mac mini: x', ctx).model, 'gpt-5');
  assert.equal(parseMessage('with gpt-5 on laptop: x', ctx).problems[0].kind, 'not-installed');
});

test('offline is only said of an offline machine; a machine that is up and lacks it says not installed', () => {
  const up = parseMessage('on mid with opus: x', ctx).problems[0];
  assert.equal(up.kind, 'not-installed');
  const off = parseMessage('on desktop with opus: x', ctx).problems[0];
  assert.equal(off.kind, 'offline');
  assert.doesNotMatch(off.text, /install/);
});

test('ambiguous: a model on two harnesses with no default among them refuses, with both', () => {
  const c = { ...ctx, defaultAgent: 'auto' };
  const [x] = parseMessage('with sonnet fix it', c).problems;
  assert.equal(x.kind, 'ambiguous');
  assert.deepEqual(x.choices, ['claude sonnet', 'cursor-agent sonnet']);
  assert.equal(parseMessage('with claude sonnet fix it', c).agent, 'claude');
  const m = parseMessage('with cursor opus-m fix it', c);
  assert.deepEqual([m.agent, m.model], ['cursor-agent', 'opus-max']);
  const y = parseMessage('with gpt- fix it', { ...c, machines: [{ id: 'm', name: 'box', usable: true, agents: [codexThere] }], agents: [codexThere] }).problems[0];
  assert.equal(y.kind, 'ambiguous');
  assert.deepEqual(y.choices, ['codex gpt-5', 'codex gpt-5-mini']);
});

test('in a thread only with, a mode and @crew are options, on the task’s own place', () => {
  const thread = { ...ctx, thread: { agent: 'claude', machine: '' } };
  const p = (t, c = thread) => parseMessage(t, c);
  assert.deepEqual([p('with sonnet carry on').model, p('with sonnet carry on').prompt], ['sonnet', 'carry on']);
  assert.equal(p('with sonnet carry on').agent, 'claude');
  assert.equal(p('with cursor sonnet carry on').agent, 'cursor-agent');
  assert.equal(p('with sonnet plan: carry on').mode, 'plan');
  for (const t of ['in api fix it', 'on laptop fix it', '#api fix it', 'plan the migration']) {
    const x = p(t);
    assert.equal(x.prompt, t);
    assert.deepEqual([x.project, x.machine, x.mode, x.notes], [null, null, null, []]);
  }
  assert.equal(p('@ada look at this').crew.name, 'Ada');
  assert.equal(p('@ada look at this').prompt, 'look at this');
  assert.equal(p('@nobody look at this').prompt, '@nobody look at this', 'not a member: words for the agent');
  assert.equal(p('stop').command, 'stop');
  assert.equal(p('done').command, 'done');
  assert.equal(p('status').command, 'status');
  assert.deepEqual([p('/btw what changed?').command, p('/btw what changed?').prompt], ['btw', 'what changed?']);
  assert.equal(p(': stop').command, null);
  assert.equal(p(': stop').prompt, 'stop');
  assert.equal(p('/goal tests pass').prompt, '/goal tests pass');
  assert.equal(p('with auto carry on').problems[0].kind, 'refused');
  const there = { ...ctx, thread: { agent: 'codex', machine: 'm-mini' } };
  assert.equal(p('with gpt-5 go', there).model, 'gpt-5');
  assert.equal(p('with gpt-5 go').problems[0].kind, 'not-installed');
  assert.equal(p('with cursor go', there).problems[0].kind, 'not-installed');
});

test('stripFormatting: Telegram', () => {
  for (const [from, to, opts] of [
    ['/new@wispbot in api fix it', '/new in api fix it'],
    ['/help@wispbot', '/help'],
    ['@wispbot in api fix it', 'in api fix it', { bot: 'wispbot' }],
    ['@WispBot: in api fix it', 'in api fix it', { bot: 'wispbot' }],
    ['@wispbotter in api', '@wispbotter in api', { bot: 'wispbot' }],
    ['\u200b in\u00a0api fix\u200b it ', 'in api fix it'],
    ['one\r\ntwo', 'one\ntwo'],
    ['__init__.py is **broken**', '__init__.py is **broken**'],
  ]) assert.equal(stripFormatting(from, 'telegram', opts), to);
  assert.equal(stripFormatting('/new@wispbot x'), '/new@wispbot x', 'only Telegram names its bot that way');
  assert.equal(stripFormatting(null), '');
});

test('findProject keeps its fuzzy match for #x and @x; bare in/on doesn’t use it', () => {
  assert.equal(findProject(projects, 'applications').name, 'web');
  assert.equal(parseMessage('in applications fix it', ctx).project, null);
  assert.equal(parseMessage('#applications fix it', ctx).project.name, 'web');
});

test('a project and a crew member with the same name: @x is the member', () => {
  const c = { ...ctx, projects: [...projects, { id: 'p9', name: 'ada', path: '/code/ada' }] };
  assert.equal(parseMessage('@ada fix it', c).crew.name, 'Ada');
  assert.equal(parseMessage('#ada fix it', c).project.name, 'ada');
});

test('every list ends with an example that works, in the user’s own names', () => {
  const view = { ...ctx, crewView: [{ ...ada, running: 1, queue: [{}] }, { ...bo, running: 0, queue: [] }, { ...mo, paused: true, queue: [] }], tasks: [{ title: 'Fix login', state: 'running' }, { title: 'Ship it', state: 'waiting' }] };
  const lists = { help: help(view), projects: projectList(view), models: models(view), modelsThere: models(view, 'mac mini'), crew: crewList(view), machines: machineList(view), status: status(view), nothing: status({ ...view, tasks: [] }) };
  for (const [name, text] of Object.entries(lists)) {
    const line = text.trim().split('\n').at(-1);
    assert.match(line, /^Try: /, name);
    const p = parseMessage(line.replace(/^Try: /, ''), view);
    assert.deepEqual(p.problems, [], `${name}: ${line}`);
    assert.ok(p.prompt, `${name}: ${line}`);
  }
  assert.match(lists.crew, /• @ada · on 1 job, 1 waiting/);
  assert.match(lists.crew, /• @mo-auto · paused/);
  assert.match(lists.machines, /desktop · offline/);
  assert.match(lists.machines, /my cloud · asleep/);
  assert.match(lists.projects, /• ops \(on laptop\)/);
  assert.match(lists.projects, /• api  ← default/);
  assert.match(lists.modelsThere, /On mac mini:/);
  assert.match(lists.modelsThere, /gpt-5/);
  assert.match(models(view, 'desktop'), /desktop is offline/);
  assert.doesNotMatch(models(view, 'desktop'), /install/);
  assert.match(models(view, 'nope'), /No machine/);
  assert.match(status(view), /Running:\n• Fix login/);
  assert.match(status(view), /Waiting for you:\n• Ship it/);
  assert.equal(projectList({ projects: [] }), 'No projects yet. Open a folder in wisp first.');
  assert.match(example({}), /^Try: plan: /);
});

test('a refusal lists the choices and says nothing started', () => {
  const text = refusal(parseMessage('on nothere: fix it', ctx).problems);
  assert.match(text, /No machine “nothere”\.\nChoices: laptop, mac mini, mid, desktop, my cloud/);
  assert.match(text, /Nothing started\./);
});

test('the ack names the model that runs: the Claude CLI puts the haiku alias on Sonnet in plan', () => {
  const note = 'Plan runs on Sonnet here, not Haiku: the Claude CLI picks it.';
  const ctx = { adapters: [claudeAdapter, { id: 'codex', name: 'Codex', models: [] }] };
  assert.equal(modelLabel(ctx, 'claude', 'haiku', '', 'plan'), 'Sonnet');
  assert.equal(modelLabel(ctx, 'claude', 'haiku', 'high', 'plan'), 'Sonnet high');
  assert.equal(modelNote(ctx, 'claude', 'haiku', 'plan'), note);
  for (const [model, mode, label] of [['haiku', 'edits', 'Haiku'], ['haiku', 'auto', 'Haiku'], ['sonnet', 'plan', 'Sonnet'], ['opus', 'plan', 'Opus'], ['', 'plan', 'Claude Code']]) {
    assert.equal(modelLabel(ctx, 'claude', model, '', mode), label);
    assert.equal(modelNote(ctx, 'claude', model, mode), '');
  }
  // The full id stays on Haiku (seen on claude 2.1.318), and a harness without a table says nothing.
  assert.equal(modelLabel(ctx, 'claude', 'claude-haiku-5-5', '', 'plan'), 'claude-haiku-5-5');
  assert.equal(modelNote(ctx, 'claude', 'claude-haiku-5-5', 'plan'), '');
  assert.equal(modelNote(ctx, 'codex', 'haiku', 'plan'), '');
  assert.equal(modelLabel(ctx, 'codex', 'haiku', '', 'plan'), 'haiku');

  const label = modelLabel(ctx, 'claude', 'haiku', '', 'plan');
  assert.equal(ackTask({ project: 'api', label, mode: 'plan', task: 'look', notes: ['', note] }), `▶ api · Sonnet · Plan\n  Look\n${note}`);
  assert.equal(ackCrew({ name: 'Ada', label, mode: 'plan', task: 'look', notes: [note] }), `▶ Ada has it · Sonnet · Plan\n  Look\n${note}`);
});

test('ranInstead: the stats’ main-thread model, when it isn’t what the task asked for', () => {
  const stats = (...models) => ({ totals: {}, models: models.map(([model, input, output = 0]) => ({ model, input, output })) });
  const sonnet = stats(['claude-sonnet-5-5', 9000, 500]);
  assert.equal(ranInstead('haiku', sonnet), 'claude-sonnet-5-5');
  assert.equal(ranInstead('claude-haiku-5-5', sonnet), 'claude-sonnet-5-5');
  // The same model by alias, full id, dated id or [1m], and nothing asked for: nothing to say.
  for (const asked of ['sonnet', 'Sonnet', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', '', undefined]) assert.equal(ranInstead(asked, sonnet), '', asked);
  assert.equal(ranInstead('sonnet', stats(['claude-sonnet-5-5-20261001', 9000])), '');
  // Most output isn't the main thread: a side call or a subagent that wrote more doesn't count.
  const busy = { ...stats(['claude-haiku-5-5', 300, 40000], ['claude-opus-5-5', 90000, 2000]), subagents: [{ type: 'x', model: 'claude-haiku-5-5', output: 40000 }] };
  assert.equal(ranInstead('opus', busy), '');
  assert.equal(ranInstead('sonnet', busy), 'claude-opus-5-5');
  // No stats, no models, or models that may be the whole conversation's.
  assert.equal(ranInstead('haiku', null), '');
  assert.equal(ranInstead('haiku', { totals: {} }), '');
  assert.equal(ranInstead('haiku', { models: sonnet.models }), '');
});
