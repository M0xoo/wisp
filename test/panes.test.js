// Panes (web/js/pane-bridge.js, web/js/features/panes.js, services/stuff.js, services/apps.js): a My
// Stuff app pinned beside tasks or on home. What it may call is what its wisp-app.json "uses" and
// you allowed; anything else is refused before it reaches wisp's API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { installFakeBins, tmp } from './helpers.js';
import { appFor, argsOf, burnOf, CALL_DOCS, dragShares, effectiveGrant, fitShares, grantOf, launchBody, lightAccounts, lightPrs, lightTask, MIN_TILE, missingOf, notWhile, PANE_APP_CSP, PANE_CALLS, PANE_CLIENT, PANE_CSP, PANE_USES, PANE_WRITES, paneFrameCsp, PANE_KIT, paneNeed, paneStale, panesProblem, panesString, paneWidthsProblem, paneWrapperDoc, parsePanes, refusal, runsFullAuto, scrubSecrets, showInvisible, TILE_GAP, tileColumns, tileEdges, tileFrom, tileSaved, tileShares, usesOf } from '../web/js/pane-bridge.js';
import { appHash, scanApp } from '../server/services/stuff.js';
import { paneGuide, PANE_EXAMPLE, paneReference } from '../server/pane-guide.js';
import { followStarters, starters } from '../server/routes/stuff.js';
import { isPaneAsk } from '../web/js/slash-text.js';
import { createPublish } from '../server/services/publish.js';
import { packAttached } from '../server/services/share.js';

process.env.WISP_HOME = tmp('panes-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();

test('tileColumns: what is asked, as far as it fits, at least one', () => {
  assert.equal(MIN_TILE, 300);
  assert.equal(TILE_GAP, 12);
  assert.equal(tileColumns(3, 1200), 3);
  assert.equal(tileColumns(3, 924), 3, 'exactly three tiles and two gaps');
  assert.equal(tileColumns(3, 923), 2);
  assert.equal(tileColumns(3, 612), 2);
  assert.equal(tileColumns(3, 611), 1);
  assert.equal(tileColumns(3, 100), 1);
  assert.equal(tileColumns(3, 0), 1);
  assert.equal(tileColumns(0, 1200), 1);
  assert.equal(tileColumns(1, 1200), 1);
  assert.equal(tileColumns(8, 1200), 3, 'more panes than fit: they wrap');
  assert.equal(tileColumns(3, 1600, 2), 2, 'a spell asks for fewer');
  assert.equal(tileColumns(3, 1600, 1), 1);
  assert.equal(tileColumns(2, 1600, 5), 2, 'never more than the panes');
  assert.equal(tileColumns(4, 700, 3), 2, 'a narrow window shows fewer than the spell asks');
});

test('paneWidthsProblem: 1 to 8 shares, each above 0 and at most 100', () => {
  for (const ok of ['1', '2,1,1', ' 2 , 1 ', '0.5,1.25', '100', '1,1,1,1,1,1,1,1']) assert.equal(paneWidthsProblem(ok), '', ok);
  for (const bad of ['', 'abc', '0,1', '1,,2', '101', '-1,2', '1e2', '1,2,3,4,5,6,7,8,9', 3, null, undefined]) assert.match(paneWidthsProblem(bad), /widths is relative shares like "2,1,1"/, String(bad));
});

test('tileShares: your drag for that many columns, else the spell, else equal', () => {
  assert.deepEqual(tileShares(3), [1, 1, 1]);
  assert.deepEqual(tileShares(3, { spell: '2,1,1' }), [2, 1, 1]);
  assert.deepEqual(tileShares(2, { spell: '2,1,1' }), [1, 1], 'not as many as the columns: equal');
  assert.deepEqual(tileShares(3, { spell: '2,1,1', saved: { 3: [1, 2, 3] } }), [1, 2, 3], 'a drag wins');
  assert.deepEqual(tileShares(2, { spell: '2,1', saved: { 3: [1, 2, 3] } }), [2, 1], 'a drag at another column count does not');
  assert.deepEqual(tileShares(3, { spell: 'abc', saved: { 3: [1, 2] } }), [1, 1, 1], 'a short save, a bad prop');
  assert.deepEqual(tileShares(2, { saved: { 2: [1, -1] } }), [1, 1]);
  assert.deepEqual(tileShares(2, { saved: { 2: 'x' } }), [1, 1]);
});

test('tileSaved and tileFrom: what was dragged counts only under the layout it was dragged in', () => {
  assert.equal(tileFrom({}), '||');
  assert.equal(tileFrom({ columns: 2, widths: '2,1', height: 500 }), '2|2,1|500');
  const stored = { from: '||', h: 500, w: { 2: [2, 1] } };
  assert.deepEqual(tileSaved(stored, '||'), { h: 500, w: stored.w });
  assert.deepEqual(tileSaved(stored, '2||'), { w: {} }, 'a spell cast since');
  assert.deepEqual(tileSaved(null, '||'), { w: {} });
  assert.deepEqual(tileSaved({ from: '||', h: 9000, w: 'x' }, '||'), { h: undefined, w: {} }, 'junk in localStorage');
});

test('fitShares: no column under the minimum, whatever the shares', () => {
  const px = (shares, room) => {
    const total = shares.reduce((a, b) => a + b);
    return shares.map((s) => (s / total) * (room - TILE_GAP * (shares.length - 1)));
  };
  assert.deepEqual(fitShares([2, 1, 1], 1600), [2, 1, 1], 'room enough: as they are');
  assert.deepEqual(fitShares([1, 1], 612), [1, 1]);
  for (const [shares, room] of [[[8, 1, 1], 1000], [[100, 1], 800], [[1, 50, 1, 1], 1400], [[3, 1, 1], 924]]) {
    for (const w of px(fitShares(shares, room), room)) assert.ok(w >= MIN_TILE - 1, `${shares} in ${room}: ${w}`);
  }
  assert.deepEqual(fitShares([3, 1, 1], 924), [1.667, 1.667, 1.667], 'exactly enough for all: equal');
});

test('tileEdges: each boundary is the middle of its gap', () => {
  assert.deepEqual(tileEdges([1], 760), []);
  assert.deepEqual(tileEdges([1, 1], 812), [406]);
  assert.deepEqual(tileEdges([1, 1, 1], 924), [306, 618]);
  assert.deepEqual(tileEdges([2, 1, 1], 1224), [606, 918]);
});

test('dragShares: moves one boundary, keeps the sum and the minimum, and rounds', () => {
  const room = 1224; // 1200 to share
  assert.deepEqual(dragShares([1, 1, 1], 0, 100, room), [1.25, 0.75, 1]);
  assert.deepEqual(dragShares([1, 1, 1], 1, -100, room), [1, 0.75, 1.25]);
  assert.deepEqual(dragShares([1, 1, 1], 0, 1000, room), [1.25, 0.75, 1], 'stops at the right one’s minimum');
  assert.deepEqual(dragShares([1, 1, 1], 0, -1000, room), [0.75, 1.25, 1], 'and the left one’s');
  assert.deepEqual(dragShares([1, 1, 1], 0, 33.3, room), [1.083, 0.917, 1]);
  const before = [2, 1, 1];
  dragShares(before, 0, 50, room);
  assert.deepEqual(before, [2, 1, 1], 'pure');
  assert.deepEqual(dragShares([1, 1], 0, 50, 500), [1, 1], 'too small for two minimums: stays');
  assert.deepEqual(dragShares([1, 1], 0, NaN, room), [1, 1]);
  const out = dragShares([1.5, 0.5, 1], 0, -999, room);
  assert.ok(Math.abs(out.reduce((a, b) => a + b) - 3) < 1e-9);
  assert.ok((out[0] / 3) * 1200 >= MIN_TILE - 1);
});

test('paneNeed: the bar’s and the row’s words for what an app still asks for', () => {
  assert.equal(paneNeed({}), '');
  assert.equal(paneNeed({ uses: ['tasks:read'], allowed: ['tasks:read'] }), '');
  assert.equal(paneNeed({ uses: ['tasks:read'] }), 'No access yet');
  assert.equal(paneNeed({ uses: ['tasks:read', 'prs:read'], allowed: ['tasks:read'] }), 'Some access not allowed');
  assert.equal(paneNeed({ uses: ['tasks:write'], allowed: [], changed: true }), 'Changed since allowed');
});

test('usesOf: wisp-app.json "uses" is a list of known scopes, deduped', () => {
  assert.deepEqual(usesOf({}), []);
  assert.deepEqual(usesOf({ uses: ['tasks:read', 'tasks:read', 'prs:read'] }), ['tasks:read', 'prs:read']);
  assert.throws(() => usesOf({ uses: 'tasks:read' }), /is a list/);
  assert.throws(() => usesOf({ uses: ['tasks:read', 'files:write'] }), /"files:write" isn't something an app can use/);
});

test('refusal: a call outside what was allowed is refused, and so is one wisp has no name for', () => {
  assert.equal(refusal('tasks.list', ['tasks:read']), '');
  assert.match(refusal('tasks.launch', ['tasks:read']), /Not allowed: tasks\.launch\(\) needs "tasks:write"/);
  assert.match(refusal('tasks.list', []), /needs "tasks:read"/);
  assert.match(refusal('prs.list', ['tasks:read', 'tasks:write']), /needs "prs:read"/);
  assert.match(refusal('crew.list', undefined), /needs "crew:read"/);
  assert.match(refusal('sessions.delete', Object.keys(PANE_USES)), /wisp has no sessions\.delete\(\)/);
  assert.match(refusal('__proto__', Object.keys(PANE_USES)), /wisp has no/);
  for (const [m, need] of Object.entries(PANE_CALLS)) assert.equal(refusal(m, [need]), '', `${m} with ${need}`);
});

test('grants: only what the app asks for, and an update that asks for less shrinks it', () => {
  assert.deepEqual(grantOf(['tasks:read'], ['tasks:read', 'tasks:write', 'tasks:read']), ['tasks:read']);
  assert.deepEqual(grantOf(['tasks:read'], 'tasks:read'), []);
  assert.deepEqual(missingOf({ uses: ['tasks:read', 'prs:read'], allowed: ['tasks:read'] }), ['prs:read']);
  assert.deepEqual(missingOf({}), []);
});

test('argsOf: ids and text are checked and capped before any call', () => {
  assert.match(argsOf('tasks.get', []).error, /needs a task id/);
  assert.match(argsOf('tasks.followUp', ['abc', '  ']).error, /needs a task id and some text/);
  assert.deepEqual(argsOf('tasks.launch', ['Fix the build']).args, [{ prompt: 'Fix the build', project: undefined }]);
  assert.deepEqual(argsOf('tasks.launch', [{ prompt: 'x', project: 'wisp', mode: 'auto', agent: 'codex' }]).args, [{ prompt: 'x', project: 'wisp' }], 'a pane can’t pick the mode or harness');
  assert.equal(argsOf('tasks.followUp', ['abc', 'y'.repeat(50_000)]).args[1].length, 20_000);
});

test('launchBody: a pane’s task runs on your New task defaults, never on the server’s fallback', () => {
  const d = { agent: 'codex', mode: 'plan', model: 'm1', effort: 'high', account: 'work' };
  assert.deepEqual(launchBody(d, 'go', { path: '/w' }), { prompt: 'go', cwd: '/w', agent: 'codex', mode: 'plan', model: 'm1', effort: 'high', account: 'work', worktree: undefined });
  assert.equal(launchBody({ ...d, mode: 'edits' }, 'go').mode, 'edits', 'not Full auto when your default isn’t');
  assert.equal(launchBody(d, 'go').scratch, true, 'no project: a scratch task');
  assert.equal(launchBody({ ...d, worktree: 'off' }, 'go', { path: '/w' }).worktree, false, 'as New task with worktrees off');
  assert.equal(launchBody({ ...d, worktree: 'on' }, 'go', { path: '/w' }).worktree, undefined);
});

test('the panes setting: "<app>@task,<app>@home", checked', () => {
  assert.deepEqual(parsePanes('kanban@home, notes@task ,solo'), [
    { app: 'kanban', where: 'home' },
    { app: 'notes', where: 'task' },
    { app: 'solo', where: 'task' },
  ]);
  assert.equal(panesString(parsePanes('a@home,b@task')), 'a@home,b@task');
  assert.equal(panesProblem(''), '');
  assert.equal(panesProblem('kanban@home'), '');
  assert.match(panesProblem('kanban@sidebar'), /should be <app id or name>@task or @home/);
  assert.match(panesProblem(Array.from({ length: 9 }, (_, i) => `a${i}@home`).join(',')), /At most 8/);
  assert.match(panesProblem(3), /is a string/);
  const items = [{ id: 'x1', kind: 'app', name: 'kanban', title: 'Task board' }, { id: 'x2', kind: 'doc', name: 'kanban' }];
  assert.equal(appFor({ app: 'x1' }, items).id, 'x1');
  assert.equal(appFor({ app: 'Task Board' }, items).id, 'x1', 'by title, any case');
  assert.equal(appFor({ app: 'nope' }, items), null);
});

test('effectiveGrant: a write scope holds for the code it was allowed on; reads aren’t tied to it', () => {
  const all = ['tasks:read', 'tasks:write'];
  assert.deepEqual(effectiveGrant(all, 'h1', 'h1'), { allowed: all, changed: false });
  assert.deepEqual(effectiveGrant(all, 'h1', 'h2'), { allowed: ['tasks:read'], changed: true });
  assert.deepEqual(effectiveGrant(all, undefined, 'h2'), { allowed: ['tasks:read'], changed: true }, 'no hash: not trusted');
  assert.deepEqual(effectiveGrant(all, '', ''), { allowed: ['tasks:read'], changed: true }, 'an unreadable folder doesn’t match no hash');
  assert.deepEqual(effectiveGrant(['tasks:read'], undefined, ''), { allowed: ['tasks:read'], changed: false });
  assert.deepEqual(effectiveGrant(undefined), { allowed: [], changed: false });
  assert.deepEqual(PANE_WRITES, ['tasks.launch', 'tasks.followUp', 'tasks.done']);
});

test('runsFullAuto: only a running task in Full auto, as the page or the server knows it', () => {
  assert.equal(runsFullAuto({ mode: 'auto', state: 'running' }), true);
  assert.equal(runsFullAuto({ mode: 'auto', state: 'review', status: 'running' }), true);
  assert.equal(runsFullAuto({ mode: 'auto', state: 'review', turns: [{ status: 'running' }] }), true);
  assert.equal(runsFullAuto({ mode: 'auto', state: 'review', status: 'done', turns: [{ status: 'done' }] }), false);
  assert.equal(runsFullAuto({ mode: 'edits', state: 'running' }), false);
  assert.equal(runsFullAuto(undefined), false);
  assert.equal(notWhile({ title: 'Big run' }), 'Not while Big run runs in Full auto.');
});

test('paneFrameCsp: exact http(s) origins only, never a wildcard', () => {
  const csp = paneFrameCsp(['http://localhost:47177', 'https://p1--ada.grid.example', 'https://grid.example', 'https://grid.example']);
  assert.equal(csp, "default-src 'none'; style-src 'unsafe-inline'; frame-src http://localhost:47177 https://p1--ada.grid.example https://grid.example");
  for (const bad of ['*', 'https:', 'https://*.grid.example', 'http://*', 'data:', 'blob:', 'javascript:alert(1)', "'self'", "'unsafe-inline'", 'https://a.example/path', 'https://a.example;script-src *', 'https://a.example https://b.example', 'ftp://a.example', '', null, 3]) {
    assert.equal(paneFrameCsp([bad]), "default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'", String(bad));
  }
  assert.match(paneFrameCsp(['http://[::1]:47100']), /frame-src http:\/\/\[::1\]:47100$/);
  const doc = paneWrapperDoc(csp);
  assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script/.test(doc), 'the wrapper runs nothing');
  assert.ok(doc.indexOf('<meta') < doc.indexOf('</head>'), 'a CSP meta only counts in the head');
});

test('showInvisible: what doesn’t print shows as <U+…>; newlines, tabs and the rest stay', () => {
  assert.equal(showInvisible('a\u202Eb'), 'a<U+202E>b');
  for (const c of ['\u200B', '\u200F', '\u202A', '\u202E', '\u2060', '\u2069', '\uFEFF', '\u0000', '\u0007', '\u001B', '\r', '\u007F', '\u0085']) {
    assert.equal(showInvisible(c), `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
  }
  assert.equal(showInvisible('\u{E0041}'), '<U+E0041>', 'tag characters spell text only an agent reads');
  assert.equal(showInvisible('line one\n\tline two'), 'line one\n\tline two');
  assert.equal(showInvisible('héllo 日本語 😀 “quoted”'), 'héllo 日本語 😀 “quoted”');
  assert.equal(showInvisible(undefined), '');
});

test('scrubSecrets: tokens are gone from what a frame gets, ordinary words aren’t', () => {
  const secrets = {
    'sk-ant-abcdefghij0123456789klmnop': /sk-ant/,
    'sk-abcdefghijklmnop': /sk-abc/,
    ['ghp_' + 'a'.repeat(36)]: /ghp_/,
    ['gho_' + 'b'.repeat(36)]: /gho_/,
    ['github_pat_' + 'c'.repeat(50)]: /github_pat/,
    AKIAABCDEFGHIJKLMNOP: /AKIA/,
    'xoxb-1234567890-abcdefghij': /xoxb/,
    'Bearer abc.def-ghi1234': /abc\.def/,
    'API_KEY=hunter2': /hunter2/,
    'MY_TOKEN = shortone': /shortone/,
    'DB_PASSWORD=pw': /=pw/,
    'client_secret=s3cr3t': /s3cr3t/,
  };
  for (const [text, gone] of Object.entries(secrets)) {
    const out = scrubSecrets(`Fix it with ${text} please`);
    assert.doesNotMatch(out, gone, text);
    assert.match(out, /^Fix it with .*redacted.* please$/, text);
  }
  for (const fine of ['Rotate the API key next week', 'Fix the token refresh', 'monkey patch sk-learn', 'if (token == null) return', 'Add a password field']) assert.equal(scrubSecrets(fine), fine);
  assert.equal(scrubSecrets(''), '');
  const t = lightTask({ id: 't', title: 'Use API_KEY=abc', preview: `token is ghp_${'d'.repeat(36)}`, live: 'Bearer zzzzzzzzzzzz' });
  assert.ok(![t.title, t.summary, t.live].join(' ').match(/abc|ghp_|zzzz/), 'title, summary and live');
  assert.deepEqual(lightPrs([{ id: 't', title: 'API_KEY=abc', pr: { url: 'u' } }]).map((p) => p.title.includes('abc')), [false]);
});

test('the pane guide comes from the schema: every scope and call, with its arguments and what it returns', () => {
  assert.deepEqual(Object.keys(CALL_DOCS).sort(), Object.keys(PANE_CALLS).sort(), 'a call without a doc fails here');
  const ref = paneReference();
  for (const m of Object.keys(PANE_CALLS)) {
    assert.ok(CALL_DOCS[m].call && CALL_DOCS[m].returns, m);
    assert.ok(ref.includes(CALL_DOCS[m].call) && ref.includes(CALL_DOCS[m].returns), m);
  }
  for (const [k, words] of Object.entries(PANE_USES)) assert.ok(ref.includes(k) && ref.includes(words), k);
  for (const fact of ['/_wisp/pane.js', '/_wisp/pane.css', 'wisp.context', "wisp.on('context'", "wisp.on('tasks'", 'wisp-app.json', 'Changed since allowed', 'bundle everything', 'Links can', 'Handle the rejection']) assert.ok(ref.includes(fact), fact);
  const guide = paneGuide('mcp__x__ask');
  assert.ok(guide.includes('mcp__x__ask'));
  for (const fact of ['wisp_save', 'pin: "home"', 'same id', 'Never ask for tasks:write when reading is enough']) assert.ok(guide.includes(fact), fact);
});

test('the guide’s example is a pane wisp accepts, and keeps to its own rules', () => {
  assert.deepEqual(usesOf(PANE_EXAMPLE.manifest), PANE_EXAMPLE.manifest.uses);
  assert.deepEqual(PANE_EXAMPLE.manifest.uses, ['tasks:read'], 'the least it needs');
  assert.ok(paneGuide().includes(PANE_EXAMPLE.html) && paneGuide().includes(PANE_EXAMPLE.manifest.name));
  assert.match(PANE_EXAMPLE.html, /\/_wisp\/pane\.js/);
  assert.doesNotMatch(PANE_EXAMPLE.html, /https?:\/\//, 'nothing from elsewhere');
  assert.match(PANE_EXAMPLE.html, /err\.message/, 'handles a refusal');
});

test('isPaneAsk: “make me a pane” in the prompt box, nothing else', () => {
  for (const yes of ['make a pane that lists PRs', 'Make me a pane', 'please make me a pane for crew', 'MAKE A PANE']) assert.equal(isPaneAsk(yes), true, yes);
  for (const no of ['make a panel', 'make me a pancake', 'fix the pane', 'can you make a pane', '']) assert.equal(isPaneAsk(no), false, no);
});

test('paneStale: a new rev means reload; the first load, the same rev or a gone app don’t', () => {
  assert.equal(paneStale(1, { rev: 2 }), true);
  assert.equal(paneStale(3, { rev: 2 }), true, 'a restore bumps it too, but any move counts');
  assert.equal(paneStale(1, {}), false, 'a new item has no rev yet');
  assert.equal(paneStale(2, { rev: 2 }), false);
  assert.equal(paneStale(undefined, { rev: 2 }), false, 'not loaded yet');
  assert.equal(paneStale(1, null), false);
});

test('usage: light per-account rows, no email or anything else an account carries', () => {
  const now = 10 * 3_600_000;
  const H = 3_600_000;
  const email = 'ada@example.com';
  const agents = [
    { id: 'auto', available: true },
    { id: 'off', name: 'Off', available: false, budget: [{ account: 'default', windows: [{ id: 'x', used: 1 }] }] },
    {
      id: 'claude',
      name: 'Claude Code',
      available: true,
      accounts: [{ id: 'default', label: 'Main', email, plan: 'max', home: '/secret' }, { id: 'w', label: email, email }, { id: 'idle', label: 'Idle', email }],
      budget: [
        { account: 'default', at: 1, drain: { x: 1 }, windows: [{ id: 'five_hour', label: '5-hour', used: 0.5, resetsAt: now + 3 * H, ms: 5 * H, hitAt: 1, line: 0.9, est: 3 }, { id: 'seven_day', label: 'Weekly', used: 1.4, resetsAt: now + 48 * H, ms: 168 * H }] },
        { account: 'w', windows: [{ id: 'five_hour', label: '5-hour', used: 0.01, resetsAt: now + 3 * H, ms: 5 * H }] },
      ],
    },
    { id: 'codex', name: 'Codex', available: true, accounts: [{ id: 'default', label: 'Main', email }] },
    { id: 'grok', name: 'Grok', available: true },
  ];
  const rows = lightAccounts(agents, now);
  assert.deepEqual(rows.map((r) => [r.agent, r.agentName, r.account, r.windows.length]), [['claude', 'Claude Code', 'Main', 2], ['claude', 'Claude Code', 'Account 2', 1], ['claude', 'Claude Code', 'Idle', 0], ['codex', 'Codex', '', 0], ['grok', 'Grok', '', 0]]);
  assert.deepEqual(rows[0].windows[0], { id: 'five_hour', label: '5-hour', used: 0.5, resetsAt: now + 3 * H, periods: [], shrink: null });
  assert.equal(rows[0].windows[1].used, 1, 'kept to 0–1');
  assert.equal(rows[0].burnPerHour, 0.25, '50% of the 5-hour window in its first 2 hours');
  assert.equal(rows[0].burnWindow, '5-hour');
  assert.equal(rows[1].burnPerHour, null, 'too little gone to tell');
  assert.equal(rows[2].burnPerHour, null);
  assert.doesNotMatch(JSON.stringify(rows), /ada@|example|\/secret|"plan"|"email"|"drain"|hitAt|"line"|"est"/);
  // Never a guess.
  assert.equal(burnOf([{ used: 0.5, resetsAt: now + H }], now).burnPerHour, null, 'no length: no start, no rate');
  assert.equal(burnOf([{ used: 0.5, ms: 5 * H }], now).burnPerHour, null, 'no reset');
  assert.equal(burnOf([{ used: 0.5, ms: 5 * H, resetsAt: now - 1 }], now).burnPerHour, null, 'already reset');
  assert.equal(burnOf([{ used: 0.5, ms: 5 * H, resetsAt: now + 5 * H - 60_000 }], now).burnPerHour, null, 'a minute in');
  assert.equal(burnOf([], now).burnPerHour, null);
  const scrubbed = lightAccounts([{ id: 'a', name: 'A', available: true, accounts: [{ id: 'x', label: 'API_KEY=abc' }, { id: 'y', label: 'b' }], budget: [{ account: 'x', windows: [] }] }], now);
  assert.doesNotMatch(JSON.stringify(scrubbed), /abc/);
});

test('usage: a window carries its periods and reading, by the budget’s account id, and nothing else', () => {
  const H = 3_600_000;
  const now = 1e12;
  const email = 'ada@example.com';
  const agents = [{ id: 'claude', name: 'Claude Code', available: true, accounts: [{ id: 'default', label: 'Main', email }, { id: 'w', label: 'Work', email }], budget: [{ account: 'default', windows: [{ id: 'seven_day', label: 'Weekly', used: 0.4, resetsAt: now + H, ms: 168 * H }, { id: 'five_hour', label: '5-hour', used: 0.1, resetsAt: now + H, ms: 5 * H }] }, { account: 'w', windows: [{ id: 'seven_day', label: 'Weekly', used: 0.2, resetsAt: now + H, ms: 168 * H }] }] }];
  const period = { end: now + H, ms: 168 * H, used: 0.4, inWisp: 0.3, outside: 0.1, work: 6, unit: 'usd', per1: 0.2, rough: true, open: true, cut: false, sessions: ['secret-task'], note: 'API_KEY=abc', cli: { version: ['1.0', 'sk-abcdefghijklmnop1234'], tools: 'hash', account: 'w', extra: 1 } };
  const closed = { end: now - H, ms: 168 * H, used: null, inWisp: 0.2, outside: null, work: 0, unit: 'usd', per1: null, full: false };
  const shrink = { state: 'less', change: -0.3, recent: 0.1, before: 0.14, unit: 'usd', from: 5, rough: true, cli: { catalog: 'hash' }, tasks: ['secret-task'] };
  const history = [{ agent: 'claude', account: 'default', windows: [{ id: 'seven_day', label: 'Weekly', periods: [period, closed], shrink }] }, { agent: 'codex', account: 'w', windows: [{ id: 'seven_day', periods: [closed], shrink }] }];
  const [main, work] = lightAccounts(agents, now, history);
  const week = main.windows[0];
  assert.deepEqual(week.periods[0], { end: now + H, ms: 168 * H, used: 0.4, inWisp: 0.3, outside: 0.1, work: 6, unit: 'usd', per1: 0.2, rough: true, open: true, cli: { version: ['1.0', '[redacted]'], tools: true } });
  assert.deepEqual([week.periods[1].used, week.periods[1].outside, week.periods[1].per1], [null, null, null], 'null stays null: it means no reading');
  assert.deepEqual(week.shrink, { state: 'less', change: -0.3, recent: 0.1, before: 0.14, unit: 'usd', from: 5, rough: true, cli: { catalog: true } });
  assert.deepEqual([main.windows[1].periods, main.windows[1].shrink], [[], null], 'a window with no history');
  assert.deepEqual([work.windows[0].periods, work.windows[0].shrink], [[], null], 'another account’s or harness’s history isn’t this one’s');
  assert.doesNotMatch(JSON.stringify([main, work]), /ada@|secret-task|abc|sk-|"account":"w"|"extra"|"note"/);
  assert.deepEqual(lightAccounts(agents, now, [])[0].windows[0].periods, [], 'none at all');
  assert.equal(lightAccounts(agents, now)[0].windows[0].shrink, null);
  assert.equal(lightAccounts(agents, now, [{ agent: 'claude', account: 'default', windows: [{ id: 'seven_day', shrink: { state: '<b>', change: 1 } }] }])[0].windows[0].shrink, null, 'only a known state');
  assert.match(PANE_USES['usage:read'], /what each period cost/);
  assert.match(CALL_DOCS['usage.accounts'].returns, /periods/);
});

test('light shapes: a task carries its harness, account and machine by name, wherever it runs', () => {
  const t = lightTask({ id: 't@m1', title: 'x', agent: 'claude', account: 'w', machine: { id: 'm1', name: 'Studio', target: 'me@studio' } }, { harness: 'Claude Code', account: 'Work' });
  assert.deepEqual([t.id, t.harness, t.account, t.machine], ['t@m1', 'Claude Code', 'Work', 'Studio']);
  assert.doesNotMatch(JSON.stringify(t), /me@studio/);
  assert.deepEqual(lightTask({ id: 't', agent: 'codex' }).harness, 'codex');
  assert.equal(lightTask({ id: 't' }, { account: 'ada@example.com' }).account, 'Account 1');
});

test('light shapes: a task never carries its turns or folder', () => {
  const s = { id: 't1', title: 'Fix', state: 'review', status: 'done', project: 'wisp', cwd: '/secret', turns: [{ prompt: 'p' }], pr: { number: 3, url: 'u', state: 'open', checks: 'pass' }, prs: [{ repo: 'o/r', pr: { number: 4, url: 'u4', state: 'open' } }] };
  const t = lightTask(s);
  assert.equal(t.title, 'Fix');
  assert.equal(t.pr.number, 3);
  assert.ok(!('turns' in t) && !('cwd' in t));
  assert.deepEqual(lightPrs([s, { id: 'w', agent: 'wisp', pr: { url: 'tour' } }]).map((p) => p.number), [3, 4], 'the tour’s left out');
});

test('/_wisp/pane.js: outside a pane every call refuses; inside, calls post to the parent', async () => {
  const run = (inPane) => {
    const posted = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const ctx = { addEventListener() {}, console, Promise, Error, Object, Map };
    ctx.window = ctx;
    ctx.parent = inPane ? parent : ctx;
    vm.runInNewContext(PANE_CLIENT, ctx);
    return { wisp: ctx.wisp, posted };
  };
  const tab = run(false);
  await assert.rejects(tab.wisp.tasks.list(), /Pin this app as a pane/);
  const pane = run(true);
  const plain = (x) => JSON.parse(JSON.stringify(x)); // from the vm's realm
  assert.deepEqual(plain(pane.posted[0]), { wispPane: 1, hello: 1 });
  pane.wisp.tasks.launch({ prompt: 'x' });
  assert.deepEqual(plain(pane.posted[1]), { wispPane: 1, id: 1, method: 'tasks.launch', args: [{ prompt: 'x' }] });
  assert.throws(() => (pane.wisp.tasks = {}), TypeError, 'frozen');
});

test('/_wisp/pane.js: wisp’s theme lands on the page’s root, for pane.css', () => {
  const top = { postMessage() {} };
  let listen;
  const root = { dataset: {} };
  const ctx = { addEventListener: (_, fn) => (listen = fn), console, Promise, Error, Object, Map, document: { documentElement: root } };
  ctx.window = ctx;
  ctx.parent = { postMessage() {}, parent: top };
  vm.runInNewContext(PANE_CLIENT, ctx);
  listen({ source: top, data: { wispPane: 1, event: 'context', data: { where: 'home', theme: 'dark' } } });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(ctx.wisp.context.theme, 'dark');
  assert.ok(ctx.wisp.usage.accounts);
});

test('/_wisp/pane.js: answers come from wisp’s page, the parent of the wrapper frame; nobody else’s count', async () => {
  const top = { postMessage() {} };
  const wrapper = { postMessage() {}, parent: top };
  let listen;
  const ctx = { addEventListener: (_, fn) => (listen = fn), console, Promise, Error, Object, Map };
  ctx.window = ctx;
  ctx.parent = wrapper;
  vm.runInNewContext(PANE_CLIENT, ctx);
  let got = 'nothing';
  ctx.wisp.tasks.list().then((x) => (got = x));
  listen({ source: {}, data: { wispPane: 1, id: 1, result: 'forged' } });
  await new Promise(setImmediate);
  assert.equal(got, 'nothing', 'another window can’t answer');
  listen({ source: top, data: { wispPane: 1, id: 1, result: 'real' } });
  await new Promise(setImmediate);
  assert.equal(got, 'real');
});

// --- the page: panes.js checks each call before it goes to the API -------------------------------

const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
    set: () => true,
  });

test('paneCall: refuses what wasn’t allowed before calling anything, and answers light tasks', async () => {
  const calls = [];
  const saved = {};
  for (const k of ['document', 'window', 'matchMedia', 'requestAnimationFrame', 'localStorage', 'addEventListener', 'location', 'history', 'fetch', 'navigator', 'setInterval', 'innerWidth', 'innerHeight']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set('document', new Proxy({}, { get: (t, k) => (k === 'querySelectorAll' ? () => [] : any()) }));
  set('window', globalThis);
  set('matchMedia', () => ({ matches: false, addEventListener() {}, addListener() {} }));
  set('requestAnimationFrame', () => 0);
  set('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  set('addEventListener', () => {});
  set('location', new URL('http://localhost/'));
  set('history', { pushState() {}, replaceState() {}, state: null });
  // Node 20 has no navigator (ui/kbd.js reads it at load).
  set('navigator', { platform: 'MacIntel', userAgent: 'node', clipboard: undefined });
  let grant = (id) => ({ allowed: S.stuff.find((x) => x.id === id)?.allowed || [], changed: false }); // what GET /stuff/:id/grant answers
  let S;
  const week = { id: 'seven_day', label: 'Weekly', used: 0.4, resetsAt: 9e12, ms: 6048e5 };
  const boards = [{ id: 'claude', name: 'Claude Code', available: true, budget: [{ account: 'default', windows: [week] }] }];
  let history = null; // GET /usage/periods fails
  set('fetch', async (url, o) => {
    calls.push([String(url), o?.method || 'GET', o?.body]);
    const asked = /\/stuff\/(\w+)\/grant$/.exec(String(url));
    if (/\/usage\/periods$/.test(url) && !history) return { ok: false, status: 500, statusText: 'no', headers: new Map(), json: async () => ({ error: 'no' }), text: async () => '' };
    const body = asked ? grant(asked[1]) : /\/usage\/periods$/.test(url) ? { accounts: history } : /\/agents$/.test(url) ? boards : { id: 'n1', title: 'New' };
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) };
  });
  set('setInterval', () => 0);
  set('innerWidth', 1440);
  set('innerHeight', 900);
  const stubs = ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Image', 'BroadcastChannel'].filter((n) => !globalThis[n]);
  for (const n of stubs)
    globalThis[n] = class {
      constructor() {
        return any();
      }
    };
  try {
    ({ S } = await import('../web/js/core/state.js'));
    const { paneCall } = await import('../web/js/features/panes.js');
    S.config = { defaults: { agent: 'codex', mode: 'edits' }, projects: [{ id: 'p1', name: 'wisp', path: '/w' }], crew: [{ id: 'm1', name: 'Ada', role: 'Lead', running: true, memory: 'secret' }] };
    S.agents = [{ id: 'codex', name: 'Codex', available: true, models: [] }];
    S.stuff = [{ id: 'a1', kind: 'app', title: 'Board', uses: ['tasks:read', 'tasks:write'], allowed: ['tasks:read'] }];
    S.sessions = new Map([['t1', { id: 't1', title: 'Fix', state: 'review', cwd: '/w', project: 'wisp', agent: 'claude', mode: 'auto' }]]);
    let f = { id: 'a1', where: 'home', writes: [] };
    const cards = [];
    const send = async (spec) => (cards.push(spec), true);
    const pinned = () => true;
    const opts = { card: send, pinned };
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'wisp' }], opts), /Not allowed: tasks\.launch\(\) needs "tasks:write"/);
    await assert.rejects(paneCall(f, 'crew.list', []), /needs "crew:read"/);
    assert.deepEqual(calls, [], 'nothing reached the API');
    assert.deepEqual(cards, [], 'and no card opened');
    await assert.rejects(paneCall(f, 'usage.accounts', []), /Not allowed: usage\.accounts\(\) needs "usage:read"/);
    assert.deepEqual(calls, [], 'usage:read refused without the grant');
    const list = await paneCall(f, 'tasks.list', []);
    assert.deepEqual(list.map((t) => [t.id, t.title, t.cwd]), [['t1', 'Fix', undefined]]);
    await assert.rejects(paneCall(f, 'tasks.get', ['nope']), /No task nope/);

    // Allowed now: a launch still waits on the card, then goes to POST /sessions on your defaults.
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    const out = await paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'wisp' }], opts);
    assert.equal(out.id, 'n1');
    const sent = calls.at(-1);
    assert.deepEqual(sent.slice(0, 2), ['/api/sessions', 'POST']);
    const body = JSON.parse(sent[2]);
    assert.deepEqual([body.prompt, body.cwd, body.agent, body.mode], ['go', '/w', 'codex', 'edits'], 'your mode, not the server’s Full auto');
    assert.equal(cards.at(-1).head, 'Board wants to start a task');
    assert.equal(cards.at(-1).prompt, 'go');
    assert.deepEqual(cards.at(-1).rows, [['Project', 'wisp'], ['Harness', 'Codex'], ['Mode', 'Edits', false]]);
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'nowhere' }], opts), /No project nowhere/);
    S.config.defaults.mode = '';
    await paneCall(f, 'tasks.launch', [{ prompt: 'no project' }], opts);
    assert.deepEqual(cards.at(-1).rows, [['Project', 'No project'], ['Harness', 'Codex'], ['Mode', 'Full auto: no permission prompts', true]], 'Full auto says so');
    assert.equal(JSON.parse(calls.at(-1)[2]).scratch, true);
    S.config.defaults.mode = 'edits';
    for (let i = 0; i < 3; i++) await paneCall(f, 'tasks.launch', [{ prompt: `go ${i}` }], opts);
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'one more' }], opts), /Slow down/);
    // usage.accounts: history comes on its own call, and a failed one leaves the windows.
    S.stuff.push({ id: 'a2', kind: 'app', title: 'Allowance', uses: ['usage:read'], allowed: ['usage:read'] });
    const board = { id: 'a2', where: 'home', writes: [] };
    const [bare] = await paneCall(board, 'usage.accounts', []);
    assert.deepEqual([bare.windows[0].used, bare.windows[0].periods, bare.windows[0].shrink], [0.4, [], null], 'the board keeps its windows');
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000; // past both caches
    try {
      history = [{ agent: 'claude', account: 'default', windows: [{ id: 'seven_day', periods: [{ end: 5, ms: 6048e5, used: 0.4, inWisp: 0.2, outside: 0.2, work: 2, unit: 'usd', per1: 0.1 }], shrink: null }] }];
      const [full] = await paneCall(board, 'usage.accounts', []);
      assert.equal(full.windows[0].periods[0].per1, 0.1);
      const asks = calls.filter(([u]) => /\/usage\/periods$/.test(u)).length;
      await paneCall(board, 'usage.accounts', []);
      assert.equal(calls.filter(([u]) => /\/usage\/periods$/.test(u)).length, asks, 'its own 30 s cache: every pane, not each');
    } finally {
      Date.now = realNow;
    }

    // Cancel: nothing goes, and it still counted.
    f = { id: 'a1', key: 'x', where: 'home', writes: [] };
    const posts = () => calls.filter((c) => c[1] === 'POST').length;
    let was = posts();
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'no' }], { pinned, card: async () => false }), /^Error: You didn’t send it\.$/);
    assert.equal(posts(), was);
    assert.equal(f.writes.length, 1);

    // One card at a time, from any pane.
    let answer;
    const first = paneCall(f, 'tasks.launch', [{ prompt: 'one' }], { pinned, card: () => new Promise((ok) => (answer = ok)) });
    while (!answer) await new Promise(setImmediate);
    const other = { id: 'a1', where: 'task', writes: [] };
    let opened = false;
    const second = { pinned, card: async () => ((opened = true), true) };
    await assert.rejects(paneCall(other, 'tasks.launch', [{ prompt: 'two' }], second), /^Error: A card is already waiting for you\.$/);
    await assert.rejects(paneCall(other, 'tasks.followUp', ['t1', 'three'], second), /A card is already waiting/);
    assert.equal(opened, false);
    answer(false);
    await assert.rejects(first, /You didn’t send it/);

    // A follow-up's card names the task; it waits on the card too, and tasks.done doesn't.
    f.writes = [];
    let followed;
    const replies = [];
    await paneCall(f, 'tasks.followUp', ['t1', 'and also'], { pinned, sendTo: async (...a) => replies.push(a), card: async (spec) => ((followed = spec), true) });
    assert.equal(followed.head, 'Board wants to send a follow-up');
    assert.deepEqual(followed.rows, [['Task', 'Fix'], ['Harness', 'claude'], ['Mode', 'Full auto: no permission prompts', true], ['State', 'Review']]);
    assert.equal(followed.prompt, 'and also');
    assert.deepEqual(replies, [['t1', 'and also']]);
    await assert.rejects(paneCall(f, 'tasks.followUp', ['gone', 'x'], { pinned, card: async () => assert.fail('no card for a task that isn’t there') }), /No task gone/);

    // After Send, what's true now counts: the pane unpinned, the grant gone, the task gone.
    f.writes = [];
    was = posts();
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'x' }], { card: send, pinned: () => false }), /isn’t pinned any more/);
    await assert.rejects(
      paneCall(f, 'tasks.launch', [{ prompt: 'x' }], {
        pinned,
        card: async () => {
          grant = () => ({ allowed: ['tasks:read'], changed: false });
          return true;
        },
      }),
      /Not allowed: tasks\.launch/,
    );
    grant = () => ({ allowed: ['tasks:read', 'tasks:write'], changed: false });
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    await assert.rejects(
      paneCall(f, 'tasks.followUp', ['t1', 'x'], {
        pinned,
        card: async () => {
          S.sessions.delete('t1');
          return true;
        },
      }),
      /No task t1/,
    );
    S.sessions.set('t1', { id: 't1', title: 'Fix', state: 'review', agent: 'claude', mode: 'auto' });
    assert.equal(posts(), was, 'none of those sent anything');

    // Its code changed: refused in those words, whatever S.stuff still believed, with no card, and
    // S.stuff catches up so the bar can say so.
    f.writes = [];
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    grant = () => ({ allowed: ['tasks:read'], changed: true });
    const noCard = { pinned, card: async () => assert.fail('no card opens by itself') };
    const CHANGED = /^Error: This pane changed since you allowed it: allow it again from its bar\.$/;
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'x' }], noCard), CHANGED);
    assert.deepEqual([S.stuff[0].allowed, S.stuff[0].changed], [['tasks:read'], true]);
    await assert.rejects(paneCall(f, 'tasks.followUp', ['t1', 'x'], noCard), CHANGED, 'and again, now S.stuff knows');
    await assert.rejects(paneCall(f, 'tasks.done', ['t1'], noCard), CHANGED);
    assert.equal((await paneCall(f, 'tasks.list', [])).length, 1, 'reads still work');

    // Going back to that code: the write works again, and the flag goes.
    f.writes = [];
    grant = () => ({ allowed: ['tasks:read', 'tasks:write'], changed: false });
    await paneCall(f, 'tasks.launch', [{ prompt: 'x' }], opts);
    assert.equal(S.stuff[0].changed, undefined);

    // At most six a minute, cancelled ones too.
    f.writes = [];
    for (let i = 0; i < 6; i++) await paneCall(f, 'tasks.launch', [{ prompt: 'no' }], { pinned, card: async () => false }).catch(() => {});
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'no' }], noCard), /Slow down/);
  } finally {
    for (const n of stubs) delete globalThis[n];
    for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

// --- the server: uses, grants, the bridge script and the CSP -----------------------------------

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
let srv;
let base;
before(async () => {
  const { startServer } = await import('../server/index.js');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});
async function api(p, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? headers : { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const appDir = (name, manifest, html = '<!doctype html><title>Board</title><script src="/_wisp/pane.js"></script>') => {
  const dir = path.join(tmp('pane-app'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'wisp-app.json'), JSON.stringify(manifest));
  return dir;
};

test('an app that uses wisp: you allow it, only what it asks; it is served with its bridge and a CSP', async () => {
  assert.throws(() => srv.stuff.addApp(appDir('bad', { name: 'Bad', uses: ['shell:run'] })), /isn't something an app can use/);
  const it = srv.stuff.addApp(appDir('board', { name: 'Board', uses: ['tasks:read', 'tasks:write'] }));
  assert.deepEqual(it.uses, ['tasks:read', 'tasks:write']);
  assert.equal(it.allowed, undefined, 'nothing allowed until you do');
  const view = await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'crew:read'] });
  assert.deepEqual(view.allowed, ['tasks:read'], 'only what it asks for');
  assert.deepEqual(view.uses, ['tasks:read', 'tasks:write']);

  const { url } = await api(`/stuff/${it.id}/launch`, {});
  const page = await fetch(url);
  assert.equal(page.headers.get('content-security-policy'), PANE_CSP, 'an app that uses wisp');
  const js = await fetch(`${url}_wisp/pane.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(await js.text(), PANE_CLIENT);

  // An update that drops tasks:write keeps tasks:read allowed; dropping uses drops the CSP too.
  srv.stuff.addApp(appDir('board2', { name: 'Board', uses: ['tasks:write'] }), { replace: it.id });
  assert.equal(srv.stuff.get(it.id).allowed, undefined, 'tasks:read is no longer asked for');
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:write'] });
  assert.deepEqual(srv.stuff.get(it.id).allowed, ['tasks:write']);
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, undefined, 'DELETE')).allowed, undefined);
  srv.stuff.addApp(appDir('board3', { name: 'Board' }), { replace: it.id });
  const again = await api(`/stuff/${it.id}/launch`, {});
  assert.equal((await fetch(again.url)).headers.get('content-security-policy'), PANE_APP_CSP, 'an app that doesn’t use wisp keeps its network and can’t frame wisp');
  assert.doesNotMatch(PANE_APP_CSP, /connect-src|default-src|http:/);
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
});

test('appHash: any file, any path or the uses change it; order doesn’t; a view stays a few stats', () => {
  const dir = appDir('hash', { name: 'H' });
  const was = appHash(dir, ['tasks:read', 'tasks:write']);
  assert.match(was, /^[0-9a-f]{64}$/);
  assert.equal(appHash(dir, ['tasks:write', 'tasks:read']), was, 'uses are sorted');
  assert.notEqual(appHash(dir, ['tasks:read']), was);
  const read = fs.readFileSync;
  const now = Date.now;
  let reads = 0;
  fs.readFileSync = (...a) => (reads++, read(...a));
  Date.now = () => now() + 10_000; // its files have settled
  try {
    assert.equal(appHash(dir, ['tasks:read', 'tasks:write']), was);
    assert.ok(reads > 0, 'first look since it settled: read');
    reads = 0;
    assert.equal(appHash(dir, ['tasks:read', 'tasks:write']), was);
    assert.equal(reads, 0, 'nothing moved: nothing read');
  } finally {
    fs.readFileSync = read;
    Date.now = now;
  }
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'one');
  const one = appHash(dir, ['tasks:read', 'tasks:write']);
  assert.notEqual(one, was);
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'two');
  assert.notEqual(appHash(dir, ['tasks:read', 'tasks:write']), one, 'same size, new content');
  fs.renameSync(path.join(dir, 'js', 'a.js'), path.join(dir, 'js', 'b.js'));
  const moved = appHash(dir, ['tasks:read', 'tasks:write']);
  assert.notEqual(moved, one);
  // The same size and time put back after an edit: ctime still shows it.
  const file = path.join(dir, 'js', 'b.js');
  const st = fs.statSync(file);
  fs.writeFileSync(file, 'xxx');
  fs.utimesSync(file, st.atime, st.mtime);
  assert.notEqual(appHash(dir, ['tasks:read', 'tasks:write']), moved);
  assert.throws(() => appHash(path.join(dir, 'nope'), []));
});

test('a write grant dies with the code it was given on, and comes back with it; reads aren’t tied', async () => {
  const it = srv.stuff.addApp(appDir('tied', { name: 'Tied', uses: ['tasks:read', 'tasks:write', 'prs:read'] }));
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: [], changed: false });
  const view = await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] });
  assert.deepEqual(view.allowed, ['tasks:read', 'tasks:write']);
  assert.equal(view.changed, undefined);
  assert.ok(!('grantHash' in view), 'the hash stays on the server');
  const stored = srv.stuff.get(it.id).grantHash;
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read', 'tasks:write'], changed: false });

  // An edit in its folder (an agent, a person): the write's off, read isn't, nothing's deleted.
  const page = path.join(srv.stuff.get(it.id).path, 'index.html');
  const code = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${code}<!-- changed -->`);
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: true });
  const seen = (await api('/stuff')).items.find((x) => x.id === it.id);
  assert.deepEqual([seen.allowed, seen.changed, 'grantHash' in seen], [['tasks:read'], true, false]);
  assert.deepEqual(srv.stuff.get(it.id).allowed, ['tasks:read', 'tasks:write'], 'stored as it was');
  fs.writeFileSync(page, code);
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read', 'tasks:write'], changed: false }, 'the same code: back');

  // wisp_save with an update: the same, and Back to the version before restores it.
  srv.stuff.addApp(appDir('tied2', { name: 'Tied', uses: ['tasks:read', 'tasks:write', 'prs:read'] }, '<!doctype html><title>New</title>'), { replace: it.id });
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: true });
  await api(`/stuff/${it.id}/restore`, {});
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read', 'tasks:write'], changed: false });

  // Allowing it again ties it to the code as it is; narrowing to reads drops the hash.
  fs.writeFileSync(path.join(srv.stuff.get(it.id).path, 'extra.js'), '1');
  assert.equal((await api(`/stuff/${it.id}/grant`)).changed, true);
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] });
  assert.notEqual(srv.stuff.get(it.id).grantHash, stored);
  assert.equal((await api(`/stuff/${it.id}/grant`)).changed, false);
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'] });
  assert.equal(srv.stuff.get(it.id).grantHash, undefined);
  fs.writeFileSync(path.join(srv.stuff.get(it.id).path, 'extra.js'), '2');
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: false }, 'reads aren’t tied to the code');

  // A grant from before this rule, with no hash: no write.
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:write'] });
  delete srv.stuff.get(it.id).grantHash;
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: [], changed: true });
  await assert.rejects(api('/stuff/nope/grant'), (e) => e.status === 404);
});

test('POST /stuff/:id/allow: no new scope while its own task runs in Full auto; narrowing always works', async () => {
  const running = (id, mode = 'auto', extra = {}) => srv.store.put({ id, title: 'Big run', state: 'running', mode, turns: [{ id: 'u1', status: 'running' }], ...extra });
  running('fa-task');
  running('fa-other', 'auto', { title: 'Crew job' });
  running('edits-task', 'edits');
  srv.store.put({ id: 'fa-idle', title: 'Done run', state: 'review', mode: 'auto', turns: [{ id: 'u1', status: 'done' }] });
  const it = srv.stuff.addApp(appDir('auto', { name: 'Auto', uses: ['tasks:read', 'tasks:write'] }), { from: { session: 'fa-task', title: 'Big run' } });
  const refused = (e) => e.status === 409 && e.message.endsWith('Not while Big run runs in Full auto.');
  await assert.rejects(api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'] }), refused, 'the task that made it');
  srv.stuff.get(it.id).from = { session: 'fa-idle', title: 'x' };
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'] })).allowed, ['tasks:read'], 'it isn’t running now');
  await assert.rejects(api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'fa-task' }), refused, 'the task it’s shown on');
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'edits-task' })).allowed, ['tasks:read', 'tasks:write'], 'another mode');
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'fa-task' })).allowed, ['tasks:read', 'tasks:write'], 'adds nothing');
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'], task: 'fa-task' })).allowed, ['tasks:read'], 'narrowing works');
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] }); // fa-other runs in Full auto: none of its business
  assert.deepEqual(srv.stuff.get(it.id).allowed, ['tasks:read', 'tasks:write'], 'an unrelated Full auto task doesn’t block');
  // Its code moved: allowing tasks:write again is adding, by the effective grant.
  fs.writeFileSync(path.join(srv.stuff.get(it.id).path, 'extra.js'), '1');
  await assert.rejects(api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'fa-task' }), refused);
  assert.equal((await api(`/stuff/${it.id}/allow`, undefined, 'DELETE')).allowed, undefined, 'DELETE always works');
  for (const id of ['fa-task', 'fa-other', 'edits-task', 'fa-idle']) srv.store.remove?.(id);
});

test('scanApp: literal WebRTC in its html and js; view says so only for an app that uses wisp', () => {
  assert.deepEqual(scanApp(appDir('clean', {})), []);
  for (const [i, code] of ['new RTCPeerConnection()', 'x = RTCDataChannel', 'webkitRTCPeerConnection'].entries()) {
    const html = appDir(`rtc-html-${i}`, {}, `<script>${code}</script>`);
    assert.deepEqual(scanApp(html), ['webrtc'], code);
  }
  const deep = appDir('rtc-js', {});
  fs.mkdirSync(path.join(deep, 'lib'));
  fs.writeFileSync(path.join(deep, 'lib', 'peer.mjs'), 'new RTCPeerConnection()');
  assert.deepEqual(scanApp(deep), ['webrtc']);
  const other = appDir('rtc-md', {});
  fs.writeFileSync(path.join(other, 'notes.md'), 'RTCPeerConnection');
  assert.deepEqual(scanApp(other), [], 'only code');
  const uses = srv.stuff.addApp(appDir('rtc-use', { name: 'Rtc', uses: ['tasks:read'] }, '<script>new RTCPeerConnection()</script>'));
  assert.deepEqual(srv.stuff.view(uses).risky, ['webrtc']);
  const none = srv.stuff.addApp(appDir('rtc-none', { name: 'Rtc2' }, '<script>new RTCPeerConnection()</script>'));
  assert.equal(srv.stuff.view(none).risky, undefined);
});

test('an app can’t write to wisp', async () => {
  const it = srv.stuff.addApp(appDir('quiet', { name: 'Quiet' }));
  const { url } = await api(`/stuff/${it.id}/launch`, {});
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/sessions`, { method: 'POST', headers: { origin: 'http://localhost:47177', 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{"prompt":"x"}');
  });
  assert.equal(status, 403);
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
  assert.ok(url);
});

test('a grant never leaves: not with a published app, not with a shared task', async () => {
  const it = srv.stuff.addApp(appDir('leave', { name: 'Leave', uses: ['tasks:read', 'tasks:write'] }));
  srv.stuff.allow(it.id, ['tasks:read', 'tasks:write']);
  const { allowed, grantHash } = srv.stuff.get(it.id);
  assert.ok(allowed.length && grantHash);

  const got = [];
  const grid = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      got.push({ url: req.url, body: Buffer.concat(parts).toString('latin1') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://x.example/s', rev: 1 }));
    });
  });
  await new Promise((r) => grid.listen(0, '127.0.0.1', r));
  try {
    const publish = createPublish({ stuff: srv.stuff }, { env: { WISP_GRID_URL: `http://127.0.0.1:${grid.address().port}`, WISP_TRUSTED_PROXY_SECRET: 's', WISP_PUBLIC_URL: 'https://ada.grid.example' } });
    await publish.publish(it.id, {});
  } finally {
    grid.closeAllConnections?.();
    grid.close();
  }
  assert.equal(got.length, 1);
  assert.match(got[0].body, /index\.html/, 'its files went');
  const out = JSON.stringify(got);
  assert.ok(!out.includes(grantHash) && !out.includes('"allowed"') && !out.includes('grantHash'));
  assert.equal(path.dirname(srv.stuff.get(it.id).path), srv.stuff.dir, 'the grant is in the record, beside the folder');
  assert.ok(!fs.readdirSync(srv.stuff.get(it.id).path).some((f) => fs.readFileSync(path.join(srv.stuff.get(it.id).path, f), 'utf8').includes(grantHash)));

  const dir = tmp('pane-share');
  const turns = [{ presentation: { blocks: [{ type: 'stuff', id: it.id }] } }];
  packAttached([turns], { dir, cwd: dir, stuff: srv.stuff });
  const card = JSON.stringify(turns);
  assert.match(card, /"Leave"/);
  assert.ok(!card.includes('allowed') && !card.includes('grantHash'));
});

test('/_wisp/pane.css: wisp’s tokens, light and dark off data-theme, and the kit; the CSP lets it in', async () => {
  const it = srv.stuff.addApp(appDir('css', { name: 'Css', uses: ['tasks:read'] }));
  const { url } = await api(`/stuff/${it.id}/launch`, {});
  const r = await fetch(`${url}_wisp/pane.css`);
  assert.match(r.headers.get('content-type'), /text\/css/);
  const css = await r.text();
  assert.match(css, /--ink:/);
  assert.match(css, /:root\[data-theme='dark'\]/);
  assert.ok(css.endsWith(PANE_KIT));
  for (const cls of ['body', '.btn', '.card', '.chip', '.muted']) assert.ok(PANE_KIT.includes(cls), cls);
  assert.match(PANE_CSP, /style-src 'self'/);
  assert.doesNotMatch(css, /url\(\s*['"]?http/, 'nothing from elsewhere');
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
});

test('starters: listed from their folders, added once, grant and pin nothing', async () => {
  const on = starters();
  assert.deepEqual(on.map((s) => s.id).sort(), ['agent-board', 'allowance-board']);
  for (const s of on) {
    assert.ok(s.name && s.description, s.id);
    const html = fs.readFileSync(new URL(`../server/starters/${s.id}/index.html`, import.meta.url), 'utf8');
    assert.match(html, /\/_wisp\/pane\.js/);
    assert.match(html, /\/_wisp\/pane\.css/);
    assert.doesNotMatch(html, /(src|href)="https?:|fetch\(|RTCPeerConnection/, `${s.id} stays on its own address`);
    assert.match(html, /Not allowed/, `${s.id} says what to do before it’s allowed`);
  }
  assert.deepEqual(on.find((s) => s.id === 'agent-board').uses, ['tasks:read', 'tasks:write', 'crew:read']);
  assert.deepEqual(on.find((s) => s.id === 'allowance-board').uses, ['usage:read']);
  const before = (await api('/stuff/starters')).starters;
  assert.ok(before.every((s) => s.added === null));
  const panes = (await api('/config')).defaults.panes;
  const it = await api('/stuff/starters/agent-board', {});
  assert.equal(it.by, 'wisp');
  assert.equal(it.title, 'Agent board');
  assert.equal(it.allowed, undefined, 'grants nothing');
  assert.equal((await api('/config')).defaults.panes, panes, 'pins nothing');
  assert.equal((await api('/stuff/starters/agent-board', {})).id, it.id, 'the same item');
  assert.equal(srv.stuff.list().filter((x) => x.title === 'Agent board').length, 1);
  assert.equal((await api('/stuff/starters')).starters.find((s) => s.id === 'agent-board').added, it.id);
  await assert.rejects(api('/stuff/starters/nope', {}), (e) => e.status === 404);
  await api(`/stuff/${it.id}`, undefined, 'DELETE');
  assert.equal((await api('/stuff/starters')).starters.find((s) => s.id === 'agent-board').added, null, 'removed: it can be added again');
});

test('a starter nobody changed follows wisp’s; a changed one stays', async () => {
  const starter = (html, was) => {
    const dir = tmp('starter');
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'wisp-app.json'), JSON.stringify({ name: 'Board', uses: ['usage:read'], ...(was && { was }) }));
    return dir;
  };
  const uses = ['usage:read'];
  const old = starter('<p>old</p>');
  const before = appHash(old, uses);
  const shipped = starter('<p>new</p>', [before]);
  const added = (src = old) => {
    const it = srv.stuff.addApp(src, { by: 'wisp', from: { key: `starter:t${Math.random()}` } });
    return srv.stuff.allow(it.id, uses);
  };
  const html = (it) => fs.readFileSync(path.join(it.path, 'index.html'), 'utf8');

  const same = added();
  srv.stuff.update(same.id, { title: 'My board', note: 'mine' });
  const it = srv.stuff.followStarter(srv.stuff.get(same.id), shipped, [before]);
  assert.equal(html(it), '<p>new</p>');
  assert.deepEqual([it.id, it.rev, it.title, it.note, it.by], [same.id, 2, 'My board', 'mine', 'wisp'], 'the same item, one version on, still yours');
  assert.deepEqual([it.uses, it.allowed], [uses, uses], 'uses stay and the grant survives');
  assert.ok(it.prev?.path && fs.existsSync(it.prev.path), 'what it was stays for Restore');
  assert.equal(srv.stuff.followStarter(it, shipped, [before]), null, 'already there: nothing to do');
  assert.ok(paneStale(1, it), 'a pinned pane reloads');

  // Went back on purpose: it stays back, also after the next boot.
  const back = srv.stuff.restore(it.id);
  assert.equal(srv.stuff.followStarter(back, shipped, [before]), null, 'Restore sticks');
  assert.equal(html(srv.stuff.get(it.id)), '<p>old</p>');

  // Two versions on: a copy that already followed once follows again.
  const middle = appHash(shipped, uses);
  const newer = starter('<p>newer</p>', [before, middle]);
  const twice = srv.stuff.followStarter(srv.stuff.followStarter(srv.stuff.get(added().id), shipped, [before]), newer, [before, middle]);
  assert.equal(html(twice), '<p>newer</p>');
  assert.equal(twice.rev, 3);

  // Changed by you or an agent: any other hash stays.
  const changed = added();
  fs.appendFileSync(path.join(changed.path, 'index.html'), '<p>mine</p>');
  assert.equal(srv.stuff.followStarter(changed, shipped, [before]), null);
  assert.equal(srv.stuff.get(changed.id).rev || 1, 1);
  assert.match(html(srv.stuff.get(changed.id)), /mine/);
  const updated = srv.stuff.addApp(starter('<p>an agent’s</p>'), { replace: added().id });
  assert.equal(srv.stuff.followStarter(updated, shipped, [before]), null);

  // At boot: by the item's key, from the folder wisp ships; a broken one stops nothing.
  const dir = tmp('starters');
  fs.cpSync(shipped, path.join(dir, 'follows'), { recursive: true });
  fs.cpSync(shipped, path.join(dir, 'not-added'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'broken'));
  const copy = srv.stuff.addApp(old, { by: 'wisp', from: { key: 'starter:follows' } });
  followStarters(srv.stuff, dir);
  assert.equal(html(srv.stuff.get(copy.id)), '<p>new</p>');
  assert.equal(srv.stuff.get(copy.id).rev, 2);
  followStarters(srv.stuff, dir);
  assert.equal(srv.stuff.get(copy.id).rev, 2, 'once');

  // What wisp ships: a folder hash each, and never the version it is now.
  for (const s of starters()) {
    const src = fileURLToPath(new URL(`../server/starters/${s.id}/`, import.meta.url));
    const { was = [] } = JSON.parse(fs.readFileSync(path.join(src, 'wisp-app.json'), 'utf8'));
    assert.ok(was.every((h) => /^[0-9a-f]{64}$/.test(h)), s.id);
    assert.ok(!was.includes(appHash(src, s.uses)), `${s.id}: a shipped hash is an earlier version`);
  }
  assert.equal(JSON.parse(fs.readFileSync(new URL('../server/starters/allowance-board/wisp-app.json', import.meta.url), 'utf8')).was.length, 1);
  assert.equal('was' in (await api('/stuff/starters')).starters[0], false, 'not the page’s business');
});

test('GET /usage/periods answers with every account’s history', async () => {
  const r = await api('/usage/periods');
  assert.ok(Array.isArray(r.accounts));
});

// A real run: the harness calls wisp_save over the bridge, as an agent does.
const until = async (fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error('timed out');
};
const finished = (id) => until(async () => (await api(`/sessions/${id}`)).turns?.at(-1)?.status !== 'running' && (await api(`/sessions/${id}`)));

test('kind pane: edits, an empty scratch folder, this computer, no compare, team or goal, and the guide in its prompt', async () => {
  const rec = tmp('pane-rec');
  process.env.FAKE_RECORD = rec;
  const s = await api('/sessions', { prompt: 'make me a pane', kind: 'pane', agent: 'claude', mode: 'auto', cwd: '/nowhere', machine: 'elsewhere', compare: [{ agent: 'codex' }], subagents: [{ name: 'x', agent: 'codex' }], goal: { text: 'x' } });
  await finished(s.id);
  delete process.env.FAKE_RECORD;
  const task = srv.store.get(s.id);
  assert.equal(task.kind, 'pane');
  assert.equal(task.mode, 'edits');
  assert.ok(srv.store.isScratch(task.cwd));
  assert.equal(task.goal, undefined);
  assert.equal((task.subagents || []).length, 0);
  assert.equal(s.kind, 'pane');
  assert.match(s.title, /^Pane: make me a pane/);
  const line = fs.readFileSync(path.join(rec, 'claude.jsonl'), 'utf8').trim().split('\n')[0];
  assert.ok(line.includes('# Making a pane'), 'the guide is in its system prompt');
  const plain = await api('/sessions', { prompt: 'x', kind: 'nonsense', scratch: true, agent: 'claude' });
  assert.equal(plain.kind, undefined);
  await finished(plain.id);
});

test('wisp_save pin: only a pane task, into the setting, within the limit, and it grants nothing', async () => {
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
  const save = async (session, body) => (await api('/internal/stuff', { session, ...body }, 'POST', { 'x-wisp-token': srv.token })).text;
  const dir = (s, name) => {
    const d = path.join(srv.store.get(s.id).cwd, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), '<title>x</title>');
    fs.writeFileSync(path.join(d, 'wisp-app.json'), JSON.stringify({ name, uses: ['tasks:read', 'tasks:write'] }));
    return name;
  };
  const other = await api('/sessions', { prompt: 'plain', scratch: true, agent: 'claude' });
  await finished(other.id);
  const said = await save(other.id, { app: dir(other, 'no-pin'), pin: 'home' });
  assert.match(said, /pin was ignored: only a Make a pane task can pin/);
  assert.equal((await api('/config')).defaults.panes || '', '', 'not pinned');

  const s = await api('/sessions', { prompt: 'a pane', kind: 'pane', agent: 'claude' });
  await finished(s.id);
  const first = await save(s.id, { app: dir(s, 'pinned'), pin: 'home' });
  assert.match(first, /Pinned on home\. Pinning grants nothing/);
  const it = srv.stuff.list().find((x) => x.title === 'pinned');
  assert.equal((await api('/config')).defaults.panes, `${it.id}@home`);
  assert.equal(it.allowed, undefined, 'nothing allowed');
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: [], changed: false });
  assert.match(await save(s.id, { app: 'pinned', id: it.id, pin: 'home' }), /already pinned/);
  assert.equal((await api('/config')).defaults.panes, `${it.id}@home`, 'once');
  assert.match(await save(s.id, { app: 'pinned', id: it.id, pin: 'sidebar' }), /pin was ignored: it pins an app, to task or home/);
  assert.match(await save(s.id, { text: '# x', name: 'x.md', pin: 'home' }), /pin was ignored/);
  const eight = Array.from({ length: 8 }, (_, i) => `a${i}@home`).join(',');
  await api('/config', { defaults: { panes: eight } }, 'PATCH');
  assert.match(await save(s.id, { app: 'pinned', id: it.id, pin: 'task' }), /It isn't pinned: 8 panes are pinned already/);
  assert.equal((await api('/config')).defaults.panes, eight);
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
});

test('a real pane run: the harness saves through wisp_save, pinned; the update makes a new rev and keeps the pin', async () => {
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
  const rec = tmp('pane-run');
  process.env.FAKE_RECORD = rec;
  const s = await api('/sessions', { prompt: 'PANESAVE task', kind: 'pane', agent: 'claude' });
  await finished(s.id);
  const it = await until(() => srv.stuff.list().find((x) => x.title === 'Fake pane' && x.from?.session === s.id));
  assert.equal((await api('/config')).defaults.panes, `${it.id}@task`);
  assert.equal(it.allowed, undefined);
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] });
  assert.equal((await api(`/stuff/${it.id}/grant`)).changed, false);
  await new Promise((r) => setTimeout(r, 5));
  await api(`/sessions/${s.id}/reply`, { text: `PANEUPDATE ${it.id}` });
  await until(() => (srv.stuff.get(it.id).rev || 1) === 2);
  await finished(s.id);
  delete process.env.FAKE_RECORD;
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: true }, 'the new code turned tasks:write off');
  await api(`/stuff/${it.id}/restore`, {});
  assert.equal(srv.stuff.get(it.id).rev, 3, 'a restore is a new rev too: the pane reloads');
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
  const said = fs.readFileSync(path.join(rec, 'pane.jsonl'), 'utf8');
  assert.match(said, /Pinned beside tasks/);
});

test('PATCH /config checks the panes setting', async () => {
  await assert.rejects(api('/config', { defaults: { panes: 'board@nowhere' } }, 'PATCH'), /@task or @home/);
  const out = await api('/config', { defaults: { panes: 'board@home' } }, 'PATCH');
  assert.equal(out.defaults.panes, 'board@home');
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
});
