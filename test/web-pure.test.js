// The page's DOM-free modules: markdown and highlighting (web/js/md.js), line diffs
// (web/js/diff.js), display formatters (web/js/core/format.js), the event bus (web/js/core/bus.js),
// what the transcript shows (web/js/features/transcript.js), the launcher's ↑ history
// (web/js/prompt-history.js), the drafts kept across reloads (web/js/core/state.js) and schedules
// in words (web/js/schedule.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, md, inlineMd, highlight, langOf } from '../web/js/md.js';
import { diffLines, hunks, countChanges } from '../web/js/diff.js';
import { ago, fmtSize, money, pct } from '../web/js/core/format.js';
import * as bus from '../web/js/core/bus.js';
import { shared } from '../web/js/core/api.js';
import { finalAnswer, layout, messageText, sameStep } from '../web/js/features/transcript.js';
import { historyStep, MAX_SENT, remember } from '../web/js/prompt-history.js';
import { isSpirit, parseSpirit, rollSpirit, SPIRIT, spiritCode, spiritDefs, spiritSvg } from '../web/js/spirit.js';
import { decode, encode, mentionHtml, plain } from '../web/js/mention-text.js';
import { clock24, cronWords, toCron } from '../web/js/schedule.js';

test('esc escapes HTML and treats null as empty', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('inline markdown: emphasis, code, links; code is not formatted inside', () => {
  assert.equal(inlineMd('**bold** and *it* and _it_ and ~~gone~~'), '<strong>bold</strong> and <em>it</em> and <em>it</em> and <del>gone</del>');
  assert.equal(inlineMd('`**not bold**`'), '<code>**not bold**</code>');
  assert.equal(inlineMd('[docs](https://x.dev/a)'), '<a href="https://x.dev/a" target="_blank" rel="noreferrer">docs</a>');
  assert.equal(inlineMd('see https://x.dev'), 'see <a href="https://x.dev" target="_blank" rel="noreferrer">https://x.dev</a>');
  // Only http(s) links become anchors.
  assert.equal(inlineMd('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inlineMd('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('block markdown: headings, lists, tasks, quotes, tables, fences, rules, paragraphs', () => {
  assert.equal(md('# Title'), '<h3>Title</h3>');
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(md('- [x] done\n- [ ] todo'), '<ul><li class="task done">done</li><li class="task ">todo</li></ul>');
  assert.equal(md('- a\n  continued'), '<ul><li>a continued</li></ul>');
  assert.equal(md('> quoted'), '<blockquote><p>quoted</p></blockquote>');
  assert.equal(md('---'), '<hr>');
  assert.equal(md('one\ntwo\n\nthree'), '<p>one two</p><p>three</p>');
  assert.equal(
    md('| a | b |\n|---|---|\n| 1 | 2 |'),
    '<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  );
  assert.equal(md('```\n<b>\n```'), '<pre class="code"><code>&lt;b&gt;</code></pre>');
  assert.equal(md('a\r\nb'), '<p>a b</p>');
  assert.equal(md(), '');
});

test('highlight marks keywords, strings, numbers, comments and types', () => {
  assert.equal(
    highlight('const x = "hi"; // note', 'js'),
    '<span class="tk-k">const</span> x = <span class="tk-s">&quot;hi&quot;</span>; <span class="tk-c">// note</span>',
  );
  assert.equal(highlight('return 42', 'ts'), '<span class="tk-k">return</span> <span class="tk-n">42</span>');
  assert.equal(highlight('new Map()', 'js'), '<span class="tk-k">new</span> <span class="tk-t">Map</span>()');
  // # is a comment only in shell-like languages.
  assert.equal(highlight('# hi', 'sh'), '<span class="tk-c"># hi</span>');
  assert.equal(highlight('#include', 'c'), '#include');
  // Plain text is only escaped.
  assert.equal(highlight('const <x>', 'text'), 'const &lt;x&gt;');
  assert.equal(highlight('const <x>'), 'const &lt;x&gt;');
});

test('langOf maps file extensions to highlighter languages', () => {
  assert.equal(langOf('a/b.mjs'), 'js');
  assert.equal(langOf('x.tsx'), 'ts');
  assert.equal(langOf('ci.yml'), 'yaml');
  assert.equal(langOf('main.go'), 'go');
});

test('diffLines: unchanged, added, removed and replaced lines with line numbers', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb'), [
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: ' ', text: 'b', a: 2, b: 2 },
  ]);
  assert.deepEqual(diffLines('', 'x'), [{ op: '+', text: 'x', b: 1 }]);
  assert.deepEqual(diffLines('x', ''), [{ op: '-', text: 'x', a: 1 }]);
  assert.deepEqual(diffLines('a\nold\nc', 'a\nnew\nc'), [
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: '-', text: 'old', a: 2 },
    { op: '+', text: 'new', b: 2 },
    { op: ' ', text: 'c', a: 3, b: 3 },
  ]);
});

test('hunks keeps context around changes and folds the rest', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l10', 'L10');
  const h = hunks(diffLines(before, after), 2);
  assert.deepEqual(
    h.map((o) => (o.op === '…' ? `…${o.count}` : `${o.op}${o.text}`)),
    ['…8', ' l8', ' l9', '-l10', '+L10', ' l11', ' l12', '…7'],
  );
  assert.deepEqual(hunks(diffLines('same', 'same')), []);
});

test('countChanges sums added and removed lines over edits', () => {
  assert.deepEqual(countChanges([{ before: 'a\nb', after: 'a\nc\nd' }, { before: '', after: 'x' }]), { add: 3, del: 1 });
  assert.deepEqual(countChanges(), { add: 0, del: 0 });
});

test('format: relative times, sizes, money and percentages', () => {
  const now = Date.now();
  assert.equal(ago(now - 10_000), 'now');
  assert.equal(ago(now - 5 * 60_000), '5m');
  assert.equal(ago(now - 3 * 3_600_000), '3h');
  assert.equal(ago(now - 2 * 86_400_000), '2d');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(money(1.234), '$1.23');
  assert.equal(money(250.6), '$251');
  assert.equal(money(undefined), '$0.00');
  assert.equal(pct(0.456), '46%');
  assert.equal(pct(null), '—');
});

test('bus: subscribers get events; one tied to a node stops once the node is gone', () => {
  const seen = [];
  const node = { isConnected: true };
  const off = bus.on('qa', (d) => seen.push(['free', d]));
  bus.on('qa', (d) => seen.push(['node', d]), { node });
  bus.emit('qa', 1);
  node.isConnected = false;
  bus.emit('qa', 2);
  node.isConnected = true; // dropped for good, even if the node came back
  bus.emit('qa', 3);
  off();
  bus.emit('qa', 4);
  bus.emit('nobody-listens', 5);
  assert.deepEqual(seen, [['free', 1], ['node', 1], ['free', 2], ['free', 3]]);
});

test('places: a task in several folders lists under each project, its card names them', async () => {
  const { inProject, projectLabel } = await import('../web/js/features/places.js');
  const s = { projectId: 'api', project: 'api', also: [{ projectId: 'web', project: 'web', color: 'teal' }] };
  assert.equal(inProject(s, 'api'), true);
  assert.equal(inProject(s, 'web'), true);
  assert.equal(inProject(s, 'docs'), false);
  assert.equal(inProject({ projectId: 'api' }, 'web'), false);
  assert.equal(projectLabel({ project: 'a<b' }), '<span class="q-proj">a&lt;b</span>');
  assert.match(projectLabel(s), /api<span class="q-also c-teal">\+ web<\/span>/);
  assert.match(projectLabel({ ...s, also: [...s.also, { project: 'docs', color: 'amber' }] }), /<span class="q-also ">\+2<\/span>/);
});

test("transcript: the final answer is the turn's last message(s), shown as blocks instead", () => {
  const answer = 'Done.\n```wisp\n{"blocks":[{"type":"hero","title":"x"}]}\n```';
  const t = {
    raw: answer,
    activity: [
      { kind: 'text', label: 'Looking around.' },
      { kind: 'run', label: 'Run the tests' },
      { kind: 'text', label: answer.slice(0, 600) },
      { kind: 'check', label: 'Tests pass', by: 'wisp' }, // Auto's note after the answer
    ],
  };
  assert.deepEqual([...finalAnswer(t)], [2]);
  // Streamed in parts: every trailing part of the answer goes.
  assert.deepEqual([...finalAnswer({ raw: 'Part one. Part two.', activity: [{ kind: 'run' }, { kind: 'text', label: 'Part one.' }, { kind: 'text', label: 'Part two.' }] })], [2, 1]);
  // No answer (stopped, failed): every message stays.
  assert.equal(finalAnswer({ activity: [{ kind: 'text', label: 'hi' }] }).size, 0);
  assert.equal(finalAnswer({ raw: 'A different answer', activity: [{ kind: 'text', label: 'Looking around.' }] }).size, 0);
});

test('transcript: a message mid-run hides the presentation it is writing', () => {
  assert.equal(messageText('All set.\n\n```wisp\n{"blocks":['), 'All set.');
  assert.equal(messageText('```wisp\n{'), '');
  assert.equal(messageText('  plain  '), 'plain');
});

test('transcript: long runs of steps fold their middle; messages split runs', () => {
  const step = (i) => ({ kind: 'run', label: `s${i}` });
  const out = layout([...Array.from({ length: 20 }, (_, i) => step(i)), { kind: 'text', label: 'hi' }, step(99)]);
  assert.deepEqual(out.map((x) => (x.fold ? `fold ${x.fold.length}` : x.label)), ['s0', 's1', 's2', 's3', 'fold 12', 's16', 's17', 's18', 's19', 'hi', 's99']);
  assert.equal(layout(Array.from({ length: 12 }, (_, i) => step(i))).length, 12, 'twelve fit without folding');
});

test('transcript: an update finds its step by call id, else by time and label', () => {
  assert.ok(sameStep({ call: 't1', label: 'a' }, { call: 't1', label: 'b' }));
  assert.ok(!sameStep({ call: 't1' }, { call: 't2' }));
  assert.ok(sameStep({ t: 5, kind: 'edit', label: 'Editing a' }, { t: 5, kind: 'edit', label: 'Editing a' }));
  assert.ok(!sameStep({ t: 5, kind: 'edit', label: 'Editing a' }, { t: 6, kind: 'edit', label: 'Editing a' }));
});

test('prompt history: the newest last, each prompt once, at most MAX_SENT', () => {
  assert.deepEqual(remember([], '  fix the tests  '), ['fix the tests']);
  assert.deepEqual(remember(['a', 'b', 'c'], 'a'), ['b', 'c', 'a'], 'sent again: it moves to the newest');
  assert.deepEqual(remember(['a'], '   '), ['a'], 'nothing to remember');
  const full = Array.from({ length: MAX_SENT }, (_, i) => `p${i}`);
  const next = remember(full, 'new');
  assert.equal(next.length, MAX_SENT);
  assert.equal(next[0], 'p1', 'the oldest goes');
  assert.equal(next.at(-1), 'new');
});

test('prompt history: ↑ from an empty box walks back, ↓ walks forward to an empty box', () => {
  const list = ['first', 'second', 'third'];
  const key = (k, value, at, lines = {}) => historyStep({ key: k, value, list, at, ...lines });
  assert.deepEqual(key('ArrowUp', '', null), { at: 2, value: 'third' });
  assert.deepEqual(key('ArrowUp', 'third', 2), { at: 1, value: 'second' });
  assert.deepEqual(key('ArrowUp', 'first', 0), null, 'nothing older: the key moves the caret');
  assert.deepEqual(key('ArrowDown', 'second', 1), { at: 2, value: 'third' });
  assert.deepEqual(key('ArrowDown', 'third', 2), { at: null, value: '' }, 'past the newest: an empty box');
  assert.equal(key('ArrowDown', '', null), null, 'not browsing: ↓ is the caret');
  assert.equal(key('ArrowUp', 'thirds', 2), null, 'edited: the arrows move the caret');
  assert.equal(key('ArrowUp', 'a draft', null), null, 'never over something typed');
  assert.equal(historyStep({ key: 'ArrowUp', value: '', list: [], at: null }), null, 'nothing sent yet');
  // A prompt of several lines: the caret goes through its lines before the next prompt shows.
  assert.equal(key('ArrowUp', 'third', 2, { firstLine: false }), null);
  assert.equal(key('ArrowDown', 'second', 1, { lastLine: false }), null);
  assert.equal(key('Enter', '', null), null);
});

test('drafts: kept as typed, back after a reload; emptied ones go, and the oldest past 50', async () => {
  const { Drafts } = await import('../web/js/core/state.js');
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } });
  try {
    const d = new Drafts();
    d.set('home', 'fix the flaky auth test');
    d.set('abc123', 'and update the docs');
    assert.deepEqual(JSON.parse(store.get('wisp.drafts')), { home: 'fix the flaky auth test', abc123: 'and update the docs' });
    assert.equal(new Drafts().get('home'), 'fix the flaky auth test', 'a reload reads them back');
    d.set('abc123', '');
    assert.equal(d.has('abc123'), false, 'an emptied box keeps no draft');
    assert.equal(d.delete('home'), true);
    assert.equal(d.delete('home'), false);
    assert.deepEqual(JSON.parse(store.get('wisp.drafts')), {});
    for (let i = 0; i < 55; i++) d.set(`s${i}`, `draft ${i}`); // s0–s4 go
    d.set('s5', 'typed in again'); // the newest now, so it stays
    for (let i = 55; i < 58; i++) d.set(`s${i}`, `draft ${i}`); // s6–s8 go
    assert.equal(d.size, 50);
    assert.deepEqual([d.has('s4'), d.get('s5'), d.has('s8'), d.has('s9'), d.get('s57')], [false, 'typed in again', false, true, 'draft 57']);
    assert.equal(Object.keys(JSON.parse(store.get('wisp.drafts'))).length, 50);
    store.set('wisp.drafts', '{"home":"ok","bad":42,"none":""}');
    assert.deepEqual([...new Drafts()], [['home', 'ok']], 'only text survives a bad store');
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
});

test('shared: a second caller shares the load on its way; since(t) reuses one asked for at t or later', async () => {
  let calls = 0;
  let fail = false;
  const load = shared(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (fail) throw new Error('down');
    return calls;
  });
  const t = performance.now();
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  await load.since(t); // done since t: no new request
  assert.equal(calls, 1);
  await load.since(performance.now() + 1); // asked for before t: load again
  assert.equal(calls, 2);
  fail = true;
  const t2 = performance.now();
  await assert.rejects(load());
  fail = false;
  await load.since(t2); // the one since t2 failed: it doesn't count
  assert.equal(calls, 4);
});

test('spirits: a name always rolls the same one, every part draws, and repaints are identical', () => {
  assert.equal(rollSpirit('Ada'), rollSpirit('Ada'));
  assert.ok(isSpirit(rollSpirit('Ada')));
  assert.equal(isSpirit('🦊'), false);
  // An unknown part falls back to the first; a bad code rolls from the seed.
  assert.deepEqual(parseSpirit('cube.teal.dots.smile.none'), { shape: 'flame', color: 'teal', eyes: 'dots', mouth: 'smile', extra: 'none' });
  assert.deepEqual(parseSpirit('nope', 'Ada'), parseSpirit(rollSpirit('Ada')));
  for (const k of Object.keys(SPIRIT))
    for (const v of SPIRIT[k]) {
      const code = spiritCode({ ...parseSpirit('blob.teal.dots.smile.none'), [k]: v });
      const svg = spiritSvg(code, { state: 'live' });
      assert.match(svg, /^<svg class="spirit c-\w+ st-live sh-\w+"/);
      assert.equal(svg, spiritSvg(code, { state: 'live' }), 'the same markup every time');
      assert.match(svg, /url\(#sp-grad-\w+\)/);
    }
  // Sleeping closes its eyes; small ones drop the mouth and extra.
  assert.notEqual(spiritSvg('blob.teal.wide.smile.crown', { state: 'sleep' }), spiritSvg('blob.teal.wide.smile.crown'));
  assert.ok(!spiritSvg('blob.teal.wide.smile.crown', { small: true }).includes('var(--spirit-gold)'));
  assert.equal((spiritDefs().match(/<radialGradient/g) || []).length, SPIRIT.color.length);
});

test('crew mentions: stored as @[Name](crew:id), shown as @Name, chips open the member', () => {
  const stored = 'ask @[Ada](crew:abc123def4) and @[Fix login](wisp:aaaaaaaaaaaa)';
  const d = decode(stored);
  assert.equal(d.text, 'ask @Ada and @Fix login');
  assert.deepEqual(d.mentions, [{ id: 'abc123def4', title: 'Ada', kind: 'crew' }, { id: 'aaaaaaaaaaaa', title: 'Fix login' }]);
  assert.equal(encode(d.text, d.mentions), stored);
  assert.equal(plain(stored), 'ask @Ada and @Fix login');
  assert.match(mentionHtml(esc(stored)), /<button type="button" class="mn crew" data-crew="abc123def4"/);
  assert.match(mentionHtml(esc(stored)), /<a class="mn" href="#\/s\/aaaaaaaaaaaa"/);
});

test('toCron reads a schedule in words, and cronWords reads it back', () => {
  const cases = {
    'every monday': ['0 9 * * 1', 'Mondays at 9:00'],
    '8am every weekday': ['0 8 * * 1-5', 'Weekdays at 8:00'],
    'Every weekday at 8 AM': ['0 8 * * 1-5', 'Weekdays at 8:00'],
    'every 15 minutes': ['*/15 * * * *', 'Every 15 min'],
    'every 15 min between 9 and 6 on weekdays': ['*/15 9-17 * * 1-5', 'Every 15 min, 9:00 to 18:00, weekdays'],
    hourly: ['0 * * * *', 'Hourly'],
    'every 2 hours': ['0 */2 * * *', 'Every 2 hours'],
    'every half hour': ['*/30 * * * *', 'Every 30 min'],
    'every day at 6pm': ['0 18 * * *', 'Every day at 18:00'],
    'weekdays at 9:30': ['30 9 * * 1-5', 'Weekdays at 9:30'],
    'mondays and fridays at 10am': ['0 10 * * 1,5', 'Mondays and Fridays at 10:00'],
    'tue-thu at 9': ['0 9 * * 2-4', 'Tuesday to Thursday at 9:00'],
    'sat and sun at 10am': ['0 10 * * 0,6', 'Weekends at 10:00'],
    'at 9am and 5pm': ['0 9,17 * * *', 'Every day at 9:00 and 17:00'],
    'on the 15th of each month at noon': ['0 12 15 * *', 'On the 15th of each month at 12:00'],
    'every friday at 5pm': ['0 17 * * 5', 'Fridays at 17:00'],
    '*/15 9-18 * * 1-5': ['*/15 9-18 * * 1-5', 'Every 15 min, 9:00 to 19:00, weekdays'],
  };
  for (const [words, [cron, back]] of Object.entries(cases)) {
    assert.equal(toCron(words), cron, words);
    assert.equal(cronWords(cron, clock24), back, cron);
  }
  // Nothing is guessed: a word it doesn't know, or what one cron line can't say, is refused.
  for (const t of ['', 'banana', 'monday standup', 'every 2 weeks', 'last day of the month', 'every 90 minutes', 'at 25', 'at 9am and 5:30pm', 'every 15 min at 9am']) assert.equal(toCron(t), null, t);
  assert.equal(cronWords('0 9 1 6 *'), null, 'months stay as cron');
});
